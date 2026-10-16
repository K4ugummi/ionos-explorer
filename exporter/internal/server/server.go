// Package server is the local web server of ionos-explorer: it serves the
// explorer UI and, on request, fetches the contract from the IONOS API with
// the same read-only crawl as ionos-export, keeping the result in memory
// until the UI takes it.
//
// It listens on loopback only and trusts nobody else on the machine: a
// per-run login secret in the URL it prints, exchanged for a session cookie
// and a session key the page sends in a header; Host and Origin checks; no
// CORS. See docs/ARCHITECTURE.md, "Security notes".
package server

import (
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"ionos-explorer/exporter/internal/endpoints"
)

// App is what /api/status answers in "app", so the UI can tell this server
// from a static host that answers every path with index.html.
const App = "ionos-explorer"

// Header carries the session key on every API request. A cross-site form
// or simple request cannot set it; a page on another local port cannot read
// the key (it lives in this origin's sessionStorage).
const Header = "X-Ionos-Explorer"

// Marker goes into the index.html this server serves (see META in
// explorer/src/backend/backend.ts).
const Marker = `<meta name="ionos-explorer" content="local-server" />`

// maxBody limits request bodies; the largest is a token and a skip list.
const maxBody = 64 << 10

// CSP is the policy of the production build (explorer/vite.config.ts; a test
// keeps them equal), sent as a header, plus what only a header can say.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
	"connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'"

type Options struct {
	// Addr is the address the listener is bound to (host:port, port not 0).
	Addr string
	// UI is served at /, index.html at its root.
	UI fs.FS
	// BaseURL sends all API requests there instead of the IONOS hosts (a
	// local mock); see endpoints.Bases.
	BaseURL string
	Version string
	// ForgetAfter drops a held token that long after its last use; 0 never.
	ForgetAfter time.Duration
	// Log gets one line per event; never a secret.
	Log io.Writer
	// OnLogin is called after the first successful login.
	OnLogin func()
	// Backoff is the first retry delay of the API client (default 1s).
	Backoff time.Duration
}

type Server struct {
	opts       Options
	bases      map[string]string
	apiHosts   []string
	hosts      map[string]bool // accepted Host headers
	loginURL   string
	secret     string // login secret, in the printed URL only
	cookieName string
	cookie     string // session cookie value
	key        string // session key, sent in Header
	loginOnce  sync.Once

	mu      sync.Mutex
	token   []byte
	keep    bool
	lastUse time.Time
	timer   *time.Timer
	job     *job
	result  []byte
	closed  bool
}

// New prepares a server for a listener bound to opts.Addr.
func New(opts Options) (*Server, error) {
	host, port, err := net.SplitHostPort(opts.Addr)
	if err != nil {
		return nil, err
	}
	if err := CheckListen(opts.Addr); err != nil {
		return nil, err
	}
	if p, err := strconv.Atoi(port); err != nil || p == 0 {
		return nil, fmt.Errorf("%s: need the bound port", opts.Addr)
	}
	if host == "localhost" {
		host = "127.0.0.1"
	}
	bases, apiHosts, err := endpoints.Bases(opts.BaseURL)
	if err != nil {
		return nil, err
	}
	if opts.Log == nil {
		opts.Log = io.Discard
	}
	s := &Server{
		opts:       opts,
		bases:      bases,
		apiHosts:   apiHosts,
		hosts:      map[string]bool{net.JoinHostPort(host, port): true, "localhost:" + port: true},
		secret:     random(),
		cookieName: "ionos-explorer-" + port,
		cookie:     random(),
		key:        random(),
	}
	s.loginURL = "http://" + net.JoinHostPort(host, port) + "/login?secret=" + s.secret
	return s, nil
}

// CheckListen accepts loopback addresses only: the server holds an API token
// and confidential data, and has no TLS.
func CheckListen(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	if host == "localhost" {
		return nil
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return nil
	}
	return fmt.Errorf("--listen %s: only loopback addresses (127.0.0.1, ::1, localhost) are supported", addr)
}

func random() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand does not fail on supported systems
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// LoginURL is the link to print and open: it logs the browser in.
func (s *Server) LoginURL() string { return s.loginURL }

func (s *Server) logf(format string, a ...any) {
	fmt.Fprintf(s.opts.Log, time.Now().Format("15:04:05")+" "+format+"\n", a...)
}

func same(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Content-Security-Policy", CSP+"; frame-ancestors 'none'")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Cross-Origin-Opener-Policy", "same-origin")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
	h.Set("Cache-Control", "no-store")

	// DNS rebinding: a name that resolves to 127.0.0.1 still says its own name.
	if !s.hosts[strings.ToLower(r.Host)] {
		http.Error(w, "Misdirected request: open the link ionos-explorer printed.", http.StatusMisdirectedRequest)
		return
	}
	switch {
	case r.URL.Path == "/login":
		s.login(w, r)
	case r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/"):
		s.api(w, r)
	default:
		s.static(w, r)
	}
}

func (s *Server) loggedIn(r *http.Request) bool {
	c, err := r.Cookie(s.cookieName)
	return err == nil && same(c.Value, s.cookie)
}

// login exchanges the secret for the session cookie and hands the page the
// session key in the fragment, which never reaches a server or a Referer.
// It answers with a page that moves on by itself rather than a redirect: a
// redirect at the end of a navigation that started elsewhere (the launcher
// file, a terminal) would not carry the SameSite=Strict cookie.
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !same(r.URL.Query().Get("secret"), s.secret) {
		s.page(w, http.StatusForbidden, "This link is not valid", "Use the link ionos-explorer printed when it started. Each run has a new one.")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: s.cookieName, Value: s.cookie, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
	s.loginOnce.Do(func() {
		s.logf("Browser logged in.")
		if s.opts.OnLogin != nil {
			s.opts.OnLogin()
		}
	})
	next := "/#session=" + s.key
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=%s">`+noIcon+`<title>IONOS Explorer</title></head>`+
		`<body><p><a href="%s">Continue to IONOS Explorer</a></p></body></html>`, next, next)
}

// static serves the UI to a logged-in browser.
func (s *Server) static(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.loggedIn(r) {
		s.page(w, http.StatusForbidden, "Not logged in", "Open the link ionos-explorer printed when it started (it ends in /login?secret=…).")
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/")
	if name == "" {
		name = "index.html"
	}
	if st, err := fs.Stat(s.opts.UI, name); !fs.ValidPath(name) || err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	if name == "index.html" {
		// Marked, so the page knows a server is there and shows fetching; a
		// static host serves the same file unmarked and the page makes no
		// request. (ServeFileFS would also redirect /index.html to ./.)
		page, err := fs.ReadFile(s.opts.UI, name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		page = bytes.Replace(page, []byte("<head>"), []byte("<head>\n    "+Marker), 1)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(page)
		return
	}
	http.ServeFileFS(w, r, s.opts.UI, name)
}

// noIcon keeps the browser from asking for /favicon.ico on the server's own
// pages (and lets them follow the dark mode).
const noIcon = `<link rel="icon" href="data:,"><meta name="color-scheme" content="light dark">`

func (s *Server) page(w http.ResponseWriter, status int, title, text string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	fmt.Fprintf(w, `<!doctype html><html lang="en"><head><meta charset="utf-8">`+noIcon+`<title>IONOS Explorer</title></head>`+
		`<body style="font-family: system-ui, sans-serif; max-width: 40em; margin: 4em auto; padding: 0 1em"><h1>%s</h1><p>%s</p></body></html>`,
		title, text)
}

// Close cancels a running fetch and drops the token and any result. The
// server answers nothing but errors afterwards.
func (s *Server) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	if s.job != nil && s.job.cancel != nil {
		s.job.cancel()
	}
	s.dropToken()
	clear(s.result)
	s.result = nil
}

var errClosed = errors.New("ionos-explorer is shutting down")
