// Package server is the local web server of ionos-explorer: it serves the
// explorer UI and, on request, fetches the contract from the IONOS API with
// the same read-only crawl as ionos-export, keeping the result in memory
// until the UI takes it.
//
// Local mode (the default) listens on loopback only and trusts nobody else
// on the machine: a per-run login secret in the URL it prints, exchanged
// for a session cookie and a session key the page sends in a header; Host
// and Origin checks; no CORS. Hosted mode (Options.Hosted) serves a team
// behind a TLS proxy: the same checks against the public URL, and a session
// per login. See docs/ARCHITECTURE.md, "Security notes".
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

	"github.com/K4ugummi/ionos-explorer/exporter/internal/endpoints"
)

// App is what /api/status answers in "app", so the UI can tell this server
// from a static host that answers every path with index.html.
const App = "ionos-explorer"

// Header carries the session key on every API request. A cross-site form
// or simple request cannot set it; a page on another local port cannot read
// the key (it lives in this origin's sessionStorage).
const Header = "X-Ionos-Explorer"

// Marker goes into the index.html this server serves (see META in
// explorer/src/backend/backend.ts); HostedMarker in hosted mode, followed by
// the session key (SESSION_META there), so every tab of a logged-in browser
// has it.
const (
	Marker       = `<meta name="ionos-explorer" content="local-server" />`
	HostedMarker = `<meta name="ionos-explorer" content="hosted" />`
	sessionMeta  = `<meta name="ionos-explorer-session" content="%s" />`
)

// maxBody limits request bodies; the largest is a token and a skip list.
const maxBody = 64 << 10

// CSP is the policy of the production build (explorer/vite.config.ts; a test
// keeps them equal), sent as a header, plus what only a header can say.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
	"connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'"

type Options struct {
	// Addr is the address the listener is bound to (host:port, port not 0).
	// Local mode only.
	Addr string
	// Hosted, if set, runs hosted mode instead of local mode.
	Hosted *Hosted
	// UI is served at /, index.html at its root.
	UI fs.FS
	// BaseURL sends all API requests there instead of the IONOS hosts (a
	// local mock); see endpoints.Bases.
	BaseURL string
	Version string
	// ForgetAfter drops a held token that long after its last use; 0 never.
	ForgetAfter time.Duration
	// Log gets one line per event; never a secret. LogJSON writes JSON
	// objects instead of text (see Logger).
	Log     io.Writer
	LogJSON bool
	// OnLogin is called after the first successful login (local mode).
	OnLogin func()
	// Backoff is the first retry delay of the API client (default 1s).
	Backoff time.Duration

	now func() time.Time // the clock of the session TTLs (tests)
}

type Server struct {
	opts       Options
	bases      map[string]string
	apiHosts   []string
	hosts      map[string]bool // accepted Host headers
	pub        publicURL       // hosted mode
	cookieName string
	now        func() time.Time
	stop       chan struct{}
	log        *Logger

	// Local mode: the printed link, and the one session it opens.
	loginURL    string
	secret      string // login secret, in the printed URL only
	local       *session
	localCookie string
	loginOnce   sync.Once

	mu       sync.Mutex
	sessions map[string]*session // by id
	running  int                 // fetches running over all sessions
	closed   bool
	notReady string // why /readyz said no last time
	// The link that creates the first admin while there are no local users.
	setupHash  string
	setupUntil time.Time
	// Logins waiting for their second factor, by the hash of the ticket.
	tickets map[string]*loginTicket
}

// New prepares a server: in local mode for a listener bound to opts.Addr,
// in hosted mode for opts.Hosted.PublicURL.
func New(opts Options) (*Server, error) {
	bases, apiHosts, err := endpoints.Bases(opts.BaseURL)
	if err != nil {
		return nil, err
	}
	s := &Server{opts: opts, bases: bases, apiHosts: apiHosts, now: opts.now, sessions: map[string]*session{}, tickets: map[string]*loginTicket{}, stop: make(chan struct{})}
	s.log = NewLogger(opts.Log, opts.LogJSON)
	if s.now == nil {
		s.now = time.Now
	}
	if opts.Hosted == nil {
		if err := s.initLocal(); err != nil {
			return nil, err
		}
		return s, nil
	}
	h := *opts.Hosted // defaults filled in on a copy
	s.opts.Hosted = &h
	if err := h.check(); err != nil {
		return nil, err
	}
	if s.pub, err = ParsePublicURL(h.PublicURL); err != nil {
		return nil, err
	}
	s.hosts = map[string]bool{s.pub.host: true}
	switch {
	case s.pub.secure && s.pub.base == "":
		s.cookieName = "__Host-ionos-explorer"
	case s.pub.secure:
		s.cookieName = "__Secure-ionos-explorer"
	default:
		s.cookieName = "ionos-explorer"
	}
	if h.Users != nil {
		empty, err := h.Users.Empty()
		if err != nil {
			return nil, err
		}
		if empty {
			s.newSetupLink()
		}
	}
	go s.janitor(30 * time.Second)
	return s, nil
}

func (s *Server) initLocal() error {
	host, port, err := net.SplitHostPort(s.opts.Addr)
	if err != nil {
		return err
	}
	if err := CheckListen(s.opts.Addr); err != nil {
		return err
	}
	if p, err := strconv.Atoi(port); err != nil || p == 0 {
		return fmt.Errorf("%s: need the bound port", s.opts.Addr)
	}
	if host == "localhost" {
		host = "127.0.0.1"
	}
	s.hosts = map[string]bool{net.JoinHostPort(host, port): true, "localhost:" + port: true}
	s.secret = random()
	s.cookieName = "ionos-explorer-" + port
	s.local, s.localCookie = s.newSession(Identity{})
	s.loginURL = "http://" + net.JoinHostPort(host, port) + "/login?secret=" + s.secret
	return nil
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

// LoginURL is the link to print and open in local mode: it logs the
// browser in.
func (s *Server) LoginURL() string { return s.loginURL }

func (s *Server) printf(format string, a ...any) { s.log.Print(fmt.Sprintf(format, a...)) }

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
	if s.pub.secure {
		// Hosted behind TLS: browsers keep to https for this host.
		h.Set("Strict-Transport-Security", "max-age=31536000")
	}

	if isProbe(r.URL.Path) {
		s.probe(w, r)
		return
	}
	// DNS rebinding: a name that resolves to 127.0.0.1 still says its own
	// name. Hosted: only the public URL's host (a wrong vhost, rebinding).
	if !s.hosts[strings.ToLower(r.Host)] {
		if s.opts.Hosted != nil {
			http.Error(w, "Misdirected request.", http.StatusMisdirectedRequest)
		} else {
			http.Error(w, "Misdirected request: open the link ionos-explorer printed.", http.StatusMisdirectedRequest)
		}
		return
	}
	path := r.URL.Path
	if h := s.opts.Hosted; h != nil {
		rest, ok := strings.CutPrefix(path, s.pub.base)
		switch {
		case !ok || rest != "" && rest[0] != '/':
			http.NotFound(w, r)
			return
		case rest == "":
			http.Redirect(w, r, s.pub.base+"/", http.StatusMovedPermanently)
			return
		}
		if a := h.loginRoute(rest); a != nil {
			a.ServeLogin(w, r, rest, func(w http.ResponseWriter, r *http.Request, id Identity) { s.login(w, r, a, id) })
			return
		}
		path = rest
	}
	switch {
	case s.opts.Hosted == nil && path == "/login":
		s.localLogin(w, r)
	case path == "/api" || strings.HasPrefix(path, "/api/"):
		s.api(w, r, path)
	default:
		s.static(w, r, path)
	}
}

// localLogin exchanges the secret for the session cookie and hands the page the
// session key in the fragment, which never reaches a server or a Referer.
// It answers with a page that moves on by itself rather than a redirect: a
// redirect at the end of a navigation that started elsewhere (the launcher
// file, a terminal) would not carry the SameSite=Strict cookie.
func (s *Server) localLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !same(r.URL.Query().Get("secret"), s.secret) {
		s.page(w, http.StatusForbidden, "This link is not valid", "Use the link ionos-explorer printed when it started. Each run has a new one.")
		return
	}
	http.SetCookie(w, s.cookie(s.localCookie))
	s.loginOnce.Do(func() {
		s.printf("Browser logged in.")
		if s.opts.OnLogin != nil {
			s.opts.OnLogin()
		}
	})
	next := "/#session=" + s.local.key
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=%s">`+noIcon+`<title>IONOS Explorer</title></head>`+
		`<body><p><a href="%s">Continue to IONOS Explorer</a></p></body></html>`, next, next)
}

// static serves the UI to a logged-in browser; path is below the base path.
func (s *Server) static(w http.ResponseWriter, r *http.Request, path string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// Hosted: the UI is public (it holds no data); without a session the
	// page shows the login screen.
	ss := s.session(r)
	if ss == nil && s.opts.Hosted == nil {
		s.page(w, http.StatusForbidden, "Not logged in", "Open the link ionos-explorer printed when it started (it ends in /login?secret=…).")
		return
	}
	name := strings.TrimPrefix(path, "/")
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
		marker := Marker
		if s.opts.Hosted != nil {
			// Holds the key: not cached anywhere (the default no-store).
			marker = HostedMarker
			if ss != nil {
				marker += "\n    " + fmt.Sprintf(sessionMeta, ss.key)
			}
			w.Header().Set("Cache-Control", "no-store")
		}
		page = bytes.Replace(page, []byte("<head>"), []byte("<head>\n    "+marker), 1)
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

// Close cancels running fetches and drops all tokens and results. The
// server answers nothing but errors afterwards.
func (s *Server) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.closed {
		close(s.stop)
	}
	s.closed = true
	for _, ss := range s.sessions {
		s.release(ss)
	}
}

var errClosed = errors.New("ionos-explorer is shutting down")
