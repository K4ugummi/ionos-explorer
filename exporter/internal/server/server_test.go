package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/K4ugummi/ionos-explorer/exporter/internal/fakeapi"
	"github.com/K4ugummi/ionos-explorer/exporter/internal/snapshot"
)

// A token that is easy to find anywhere it should not be.
const token = "tok-SECRET-4f1c2b9e-never-show-me"

// syncBuffer collects log lines written from several goroutines.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type harness struct {
	t      *testing.T
	s      *Server
	url    string // http://127.0.0.1:port
	host   string // 127.0.0.1:port
	api    *fakeapi.Server
	log    *syncBuffer
	logins int
	// Everything the server answered, to search for the token.
	seen   bytes.Buffer
	cookie *http.Cookie
	key    string
}

var ui = fstest.MapFS{
	"index.html":          {Data: []byte("<!doctype html><html><head><title>explorer ui</title></head></html>")},
	"assets/index-abc.js": {Data: []byte("console.log('ui')")},
	"assets/sub/x.css":    {Data: []byte("body{}")},
}

func start(t *testing.T, mod func(*Options)) *harness {
	t.Helper()
	demo, err := fakeapi.Demo()
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{t: t, log: &syncBuffer{}}
	h.api = &fakeapi.Server{Snap: demo, Token: token, PageSize: 7, Errorf: t.Errorf}
	ionos := httptest.NewServer(h.api)
	t.Cleanup(ionos.Close)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	opts := Options{
		Addr: ln.Addr().String(), UI: ui, BaseURL: ionos.URL, Version: "test", Log: h.log,
		ForgetAfter: time.Hour, Backoff: time.Millisecond,
		OnLogin: func() { h.logins++ },
	}
	if mod != nil {
		mod(&opts)
	}
	h.s, err = New(opts)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewUnstartedServer(h.s)
	srv.Listener.Close()
	srv.Listener = ln
	srv.Start()
	t.Cleanup(srv.Close)
	t.Cleanup(h.s.Close)
	h.url, h.host = srv.URL, ln.Addr().String()
	return h
}

type req struct {
	method, path, body string
	header             map[string]string // "" deletes a default
	noCookie, noKey    bool
}

// do sends a request as the logged-in page would, with the changes in r.
func (h *harness) do(r req) (*http.Response, []byte) {
	h.t.Helper()
	if r.method == "" {
		r.method = http.MethodGet
	}
	var body io.Reader
	if r.body != "" {
		body = strings.NewReader(r.body)
	}
	hr, err := http.NewRequest(r.method, h.url+r.path, body)
	if err != nil {
		h.t.Fatal(err)
	}
	if h.cookie != nil && !r.noCookie {
		hr.AddCookie(h.cookie)
	}
	if h.key != "" && !r.noKey {
		hr.Header.Set(Header, h.key)
	}
	if r.method == http.MethodPost {
		hr.Header.Set("Origin", h.url)
		hr.Header.Set("Content-Type", "application/json")
		hr.Header.Set("Sec-Fetch-Site", "same-origin")
	}
	for k, v := range r.header {
		if k == "Host" {
			hr.Host = v
		} else if v == "" {
			hr.Header.Del(k)
		} else {
			hr.Header.Set(k, v)
		}
	}
	resp, err := http.DefaultTransport.RoundTrip(hr) // no redirects, no cookie jar
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	_ = resp.Header.Write(&h.seen)
	h.seen.Write(b)
	return resp, b
}

var sessionLink = regexp.MustCompile(`url=/#session=([A-Za-z0-9_-]+)"`)

func (h *harness) login() {
	h.t.Helper()
	resp, b := h.do(req{path: "/login?secret=" + h.s.secret})
	if resp.StatusCode != http.StatusOK {
		h.t.Fatalf("login: %d %s", resp.StatusCode, b)
	}
	m := sessionLink.FindSubmatch(b)
	if m == nil || len(resp.Cookies()) != 1 {
		h.t.Fatalf("login page %s, cookies %v", b, resp.Cookies())
	}
	h.cookie, h.key = resp.Cookies()[0], string(m[1])
}

func (h *harness) status() Status {
	h.t.Helper()
	resp, b := h.do(req{path: "/api/status"})
	var st Status
	if resp.StatusCode != http.StatusOK || json.Unmarshal(b, &st) != nil {
		h.t.Fatalf("status: %d %s", resp.StatusCode, b)
	}
	return st
}

func (h *harness) post(path, body string) (int, string) {
	h.t.Helper()
	resp, b := h.do(req{method: http.MethodPost, path: path, body: body})
	return resp.StatusCode, string(b)
}

// wait polls until the fetch is no longer running, checking the progress.
func (h *harness) wait() *Fetch {
	h.t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		st := h.status()
		f := st.Fetch
		if f == nil {
			h.t.Fatal("no fetch")
		}
		if f.Done > f.Total {
			h.t.Errorf("progress %d of %d", f.Done, f.Total)
		}
		if f.State != stateRunning {
			return f
		}
		time.Sleep(5 * time.Millisecond)
	}
	h.t.Fatal("fetch did not finish")
	return nil
}

func TestLogin(t *testing.T) {
	h := start(t, nil)
	for _, bad := range []string{"", "?secret=", "?secret=nope", "?secret=" + h.s.secret + "x", "?secret=" + h.s.key} {
		resp, b := h.do(req{path: "/login" + bad})
		if resp.StatusCode != http.StatusForbidden || len(resp.Cookies()) > 0 || bytes.Contains(b, []byte("session=")) {
			t.Errorf("%q: %d %v", bad, resp.StatusCode, resp.Cookies())
		}
	}
	h.login()
	c := h.cookie
	_, port, _ := net.SplitHostPort(h.host)
	if c.Name != "ionos-explorer-"+port || !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Path != "/" || c.Value == "" {
		t.Errorf("cookie %+v", c)
	}
	// Three different secrets: the printed one, the cookie, the page's key.
	if c.Value == h.s.secret || h.key == h.s.secret || h.key == c.Value || len(h.key) < 40 {
		t.Error("secrets are not independent")
	}
	resp, b := h.do(req{path: "/login?secret=" + h.s.secret})
	if resp.Header.Get("Location") != "" || bytes.Contains(b, []byte(h.s.secret)) {
		t.Error("the login page must not redirect or repeat the secret")
	}
	if !strings.HasPrefix(h.s.LoginURL(), "http://"+h.host+"/login?secret=") || h.logins != 1 {
		t.Errorf("%s, %d logins reported", h.s.LoginURL(), h.logins)
	}
	if resp, _ := h.do(req{method: http.MethodPost, path: "/login?secret=" + h.s.secret}); resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST /login: %d", resp.StatusCode)
	}
}

func TestPageNeedsLogin(t *testing.T) {
	h := start(t, nil)
	resp, b := h.do(req{path: "/"})
	if resp.StatusCode != http.StatusForbidden || bytes.Contains(b, []byte("explorer ui")) {
		t.Errorf("/ without login: %d %s", resp.StatusCode, b)
	}
	if resp, _ := h.do(req{path: "/assets/index-abc.js"}); resp.StatusCode != http.StatusForbidden {
		t.Errorf("asset without login: %d", resp.StatusCode)
	}
	h.login()
	h.cookie.Value = "forged"
	if resp, _ := h.do(req{path: "/"}); resp.StatusCode != http.StatusForbidden {
		t.Errorf("forged cookie: %d", resp.StatusCode)
	}
	h.login()
	for path, want := range map[string]string{"/": "explorer ui", "/index.html": "explorer ui", "/assets/index-abc.js": "console.log", "/assets/sub/x.css": "body{}"} {
		resp, b := h.do(req{path: path})
		if resp.StatusCode != http.StatusOK || !bytes.Contains(b, []byte(want)) {
			t.Errorf("%s: %d %s", path, resp.StatusCode, b)
		}
	}
	if _, b := h.do(req{path: "/"}); !bytes.Contains(b, []byte("<head>\n    "+Marker+"<title>")) {
		t.Errorf("index.html is not marked: %s", b)
	}
	if resp, _ := h.do(req{path: "/assets/index-abc.js"}); !strings.Contains(resp.Header.Get("Content-Type"), "javascript") {
		t.Errorf("content type %q", resp.Header.Get("Content-Type"))
	}
	for _, path := range []string{"/nope", "/assets", "/assets/", "/../go.mod", "/assets/../index.html/"} {
		if resp, _ := h.do(req{path: path}); resp.StatusCode != http.StatusNotFound {
			t.Errorf("%s: %d", path, resp.StatusCode)
		}
	}
	if resp, _ := h.do(req{method: http.MethodPost, path: "/"}); resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST /: %d", resp.StatusCode)
	}
}

func TestSecurityHeaders(t *testing.T) {
	h := start(t, nil)
	check := func(name string, resp *http.Response) {
		t.Helper()
		hd := resp.Header
		if hd.Get("Content-Security-Policy") != CSP+"; frame-ancestors 'none'" || hd.Get("X-Content-Type-Options") != "nosniff" ||
			hd.Get("Referrer-Policy") != "no-referrer" || hd.Get("X-Frame-Options") != "DENY" || hd.Get("Cross-Origin-Opener-Policy") != "same-origin" {
			t.Errorf("%s: %v", name, hd)
		}
		for k := range hd {
			if strings.HasPrefix(k, "Access-Control-") {
				t.Errorf("%s: CORS header %s", name, k)
			}
		}
	}
	resp, _ := h.do(req{path: "/"})
	check("refused page", resp)
	resp, _ = h.do(req{path: "/login?secret=" + h.s.secret})
	check("login", resp)
	if resp.Header.Get("Cache-Control") != "no-store" {
		t.Error("login must not be cached")
	}
	h.login()
	resp, _ = h.do(req{path: "/"})
	check("page", resp)
	for _, r := range []req{{path: "/api/status"}, {method: http.MethodPost, path: "/api/forget", body: "{}"}, {path: "/api/status", noKey: true}} {
		resp, _ := h.do(r)
		check(r.path, resp)
		if resp.Header.Get("Cache-Control") != "no-store" || resp.Header.Get("Content-Type") != "application/json" {
			t.Errorf("%s: %v", r.path, resp.Header)
		}
	}
	// A CORS preflight gets nothing that would allow the request.
	resp, _ = h.do(req{method: http.MethodOptions, path: "/api/fetch", header: map[string]string{
		"Origin": "https://evil.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": Header,
	}})
	check("preflight", resp)
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("preflight: %d", resp.StatusCode)
	}
}

func TestHostCheck(t *testing.T) {
	// DNS rebinding: evil.example resolves to 127.0.0.1, the browser sends its name.
	h := start(t, nil)
	h.login()
	_, port, _ := net.SplitHostPort(h.host)
	for _, host := range []string{"evil.example:" + port, "evil.example", "127.0.0.1", "127.0.0.1:1", "localhost.evil.example:" + port, "[::1]:" + port} {
		for _, path := range []string{"/", "/login?secret=" + h.s.secret, "/api/status"} {
			resp, b := h.do(req{path: path, header: map[string]string{"Host": host}})
			if resp.StatusCode != http.StatusMisdirectedRequest || len(resp.Cookies()) > 0 || bytes.Contains(b, []byte("explorer ui")) {
				t.Errorf("Host %s %s: %d", host, path, resp.StatusCode)
			}
		}
	}
	for _, host := range []string{h.host, "localhost:" + port, "LOCALHOST:" + port} {
		if resp, _ := h.do(req{path: "/api/status", header: map[string]string{"Host": host}}); resp.StatusCode != http.StatusOK {
			t.Errorf("Host %s: %d", host, resp.StatusCode)
		}
	}
}

func TestAPINeedsCookieAndKey(t *testing.T) {
	h := start(t, nil)
	if resp, b := h.do(req{path: "/api/status"}); resp.StatusCode != http.StatusUnauthorized || !bytes.Contains(b, []byte(`"app":"ionos-explorer"`)) {
		t.Errorf("no session: %d %s", resp.StatusCode, b)
	}
	h.login()
	key := h.key
	for name, r := range map[string]req{
		"no cookie":                      {path: "/api/status", noCookie: true},
		"no key":                         {path: "/api/status", noKey: true},
		"key in a query, not the header": {path: "/api/status?" + Header + "=" + key, noKey: true},
	} {
		if resp, b := h.do(r); resp.StatusCode != http.StatusUnauthorized || bytes.Contains(b, []byte("tokenHeld")) {
			t.Errorf("%s: %d %s", name, resp.StatusCode, b)
		}
	}
	h.key = key + "x"
	if resp, _ := h.do(req{path: "/api/status"}); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("wrong key: %d", resp.StatusCode)
	}
	h.key = h.cookie.Value // the cookie value is not the key
	if resp, _ := h.do(req{path: "/api/status"}); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("cookie as key: %d", resp.StatusCode)
	}
	h.key = key
	if st := h.status(); st.App != App || st.Version != "test" || st.TokenHeld || st.Fetch != nil {
		t.Errorf("%+v", st)
	}
	// A POST without the key is refused before anything happens.
	if resp, _ := h.do(req{method: http.MethodPost, path: "/api/fetch", body: `{"token":"` + token + `"}`, noKey: true}); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("fetch without key: %d", resp.StatusCode)
	}
	if h.status().TokenHeld || h.api.Requests.Load() != 0 {
		t.Error("an unauthenticated request took effect")
	}
}

func TestRequestChecks(t *testing.T) {
	h := start(t, nil)
	h.login()
	forget := func(header map[string]string, body string) int {
		resp, _ := h.do(req{method: http.MethodPost, path: "/api/forget", body: body, header: header})
		return resp.StatusCode
	}
	for name, c := range map[string]struct {
		header map[string]string
		want   int
	}{
		"ok":                    {nil, 200},
		"no Origin":             {map[string]string{"Origin": ""}, 403},
		"foreign Origin":        {map[string]string{"Origin": "https://evil.example"}, 403},
		"null Origin":           {map[string]string{"Origin": "null"}, 403},
		"other port":            {map[string]string{"Origin": "http://127.0.0.1:1"}, 403},
		"cross-site":            {map[string]string{"Sec-Fetch-Site": "cross-site"}, 403},
		"same-site":             {map[string]string{"Sec-Fetch-Site": "same-site"}, 403},
		"no Sec-Fetch-Site":     {map[string]string{"Sec-Fetch-Site": ""}, 200}, // older browsers
		"form":                  {map[string]string{"Content-Type": "application/x-www-form-urlencoded"}, 415},
		"text":                  {map[string]string{"Content-Type": "text/plain"}, 415},
		"no type":               {map[string]string{"Content-Type": ""}, 415},
		"json with charset":     {map[string]string{"Content-Type": "application/json; charset=utf-8"}, 200},
		"cross-site GET status": {map[string]string{"Sec-Fetch-Site": "cross-site"}, -1},
	} {
		if c.want == -1 {
			if resp, _ := h.do(req{path: "/api/status", header: c.header}); resp.StatusCode != 403 {
				t.Errorf("%s: %d", name, resp.StatusCode)
			}
			continue
		}
		if got := forget(c.header, "{}"); got != c.want {
			t.Errorf("%s: %d, want %d", name, got, c.want)
		}
	}
	if got := forget(nil, `{"token":"`+strings.Repeat("x", maxBody)+`"}`); got != http.StatusRequestEntityTooLarge {
		t.Errorf("large body: %d", got)
	}
	for _, r := range []req{{method: http.MethodPut, path: "/api/fetch"}, {method: http.MethodDelete, path: "/api/forget"}} {
		if resp, _ := h.do(r); resp.StatusCode != http.StatusMethodNotAllowed {
			t.Errorf("%s %s: %d", r.method, r.path, resp.StatusCode)
		}
	}
	for _, r := range []req{{path: "/api/fetch/result"}, {method: http.MethodPost, path: "/api/nope", body: "{}"}} {
		if resp, _ := h.do(r); resp.StatusCode != http.StatusNotFound {
			t.Errorf("%s %s: %d", r.method, r.path, resp.StatusCode)
		}
	}
	for body, want := range map[string]string{
		`{"token":"a b"}`:                     "does not look like an API token",
		`{"token":"x","skip":["/um; rm"]}`:    "skip:",
		`{"token":"x","contractNumber":"1a"}`: "digits only",
		`{"token":"x","extra":1}`:             "malformed",
		`not json`:                            "malformed",
		`{}`:                                  "enter an API token",
	} {
		if code, b := h.post("/api/fetch", body); code != http.StatusBadRequest || !strings.Contains(b, want) {
			t.Errorf("%s: %d %s", body, code, b)
		}
	}
	if h.api.Requests.Load() != 0 {
		t.Error("a refused fetch reached the API")
	}
}

func TestFetch(t *testing.T) {
	h := start(t, nil)
	h.login()
	code, b := h.post("/api/fetch", `{"token":" `+token+` ","keep":true,"skip":["vpn"," "]}`)
	if code != http.StatusAccepted || !strings.Contains(b, `"state":"running"`) {
		t.Fatalf("%d %s", code, b)
	}
	f := h.wait()
	// The demo hides /um/users and /um/groups from the exporting user.
	if f.State != stateDone || f.Done != f.Total || f.Total < 80 || f.Problems != 2 || !f.ResultReady || f.Size < 10<<10 || f.FinishedAt == nil {
		t.Fatalf("%+v", f)
	}
	st := h.status()
	if !st.TokenHeld || st.TokenForgetAt == nil || time.Until(*st.TokenForgetAt) < 59*time.Minute {
		t.Errorf("token: %+v", st)
	}

	resp, data := h.do(req{method: http.MethodPost, path: "/api/fetch/result", body: "{}"})
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "application/octet-stream" {
		t.Fatalf("result: %d", resp.StatusCode)
	}
	snap, err := snapshot.Read(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	m := snap.Manifest
	if m.Generator.Name != "ionos-explorer" || m.Contract == nil || m.Contract.Number != 31812345 || len(snap.Files) < 80 {
		t.Errorf("%+v %+v %d files", m.Generator, m.Contract, len(snap.Files))
	}
	for _, c := range m.Coverage {
		if strings.HasPrefix(c.API, "vpn-") && c.Status != snapshot.StatusSkipped {
			t.Errorf("vpn not skipped: %+v", c)
		}
	}
	// Handed over once, then gone from the server.
	if resp, _ := h.do(req{method: http.MethodPost, path: "/api/fetch/result", body: "{}"}); resp.StatusCode != http.StatusNotFound {
		t.Errorf("second take: %d", resp.StatusCode)
	}
	if h.s.result != nil || h.status().Fetch.ResultReady {
		t.Error("the server kept the snapshot")
	}

	// Refresh with the held token.
	before := h.api.Requests.Load()
	if code, b := h.post("/api/fetch", `{"keep":false}`); code != http.StatusAccepted {
		t.Fatalf("%d %s", code, b)
	}
	if f := h.wait(); f.State != stateDone || h.api.Requests.Load() <= before {
		t.Errorf("%+v", f)
	}
	if h.status().TokenHeld {
		t.Error("keep:false must drop the token after the fetch")
	}
	if code, b := h.post("/api/fetch", `{}`); code != http.StatusBadRequest || !strings.Contains(b, "enter an API token") {
		t.Errorf("%d %s", code, b)
	}
	// An untaken result is dropped by the next fetch.
	if !h.status().Fetch.ResultReady {
		t.Error("no result")
	}
	h.post("/api/fetch", `{"token":"`+token+`","keep":true}`)
	h.wait()
	if !strings.Contains(h.log.String(), "Fetched ") {
		t.Errorf("log: %s", h.log.String())
	}
}

// blocker makes the fake API hang on /datacenters until released; arm
// starts a new round.
type blocker struct {
	mu      sync.Mutex
	gate    chan struct{}
	started chan struct{}
}

func newBlocker(h *harness) *blocker {
	b := &blocker{started: make(chan struct{}, 100)}
	h.api.Intercept = func(w http.ResponseWriter, r *http.Request) bool {
		if strings.HasSuffix(r.URL.Path, "/datacenters") {
			b.mu.Lock()
			gate := b.gate
			b.mu.Unlock()
			if gate != nil {
				b.started <- struct{}{}
				select {
				case <-gate:
				case <-r.Context().Done():
				}
			}
		}
		return false
	}
	return b
}

func (b *blocker) arm() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.gate = make(chan struct{})
}

func (b *blocker) release() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.gate != nil {
		close(b.gate)
		b.gate = nil
	}
}

func TestOneFetchAtATimeAndCancel(t *testing.T) {
	h := start(t, nil)
	h.login()
	b := newBlocker(h)
	defer b.release()
	b.arm()
	if code, body := h.post("/api/fetch", `{"token":"`+token+`","keep":true}`); code != http.StatusAccepted {
		t.Fatalf("%d %s", code, body)
	}
	<-b.started
	if code, body := h.post("/api/fetch", `{"token":"`+token+`","keep":true}`); code != http.StatusConflict || !strings.Contains(body, "already running") {
		t.Errorf("second fetch: %d %s", code, body)
	}
	if st := h.status(); st.Fetch.State != stateRunning || st.Fetch.Done == 0 || st.Fetch.Total <= st.Fetch.Done {
		t.Errorf("while running: %+v", st.Fetch)
	}
	if code, _ := h.post("/api/fetch/cancel", "{}"); code != http.StatusOK {
		t.Errorf("cancel: %d", code)
	}
	f := h.wait()
	if f.State != stateCancelled || f.ResultReady || f.Error != "" {
		t.Errorf("%+v", f)
	}
	if !h.status().TokenHeld {
		t.Error("cancel should keep the token")
	}
	// Forget while fetching cancels the fetch too.
	b.release()
	b.arm()
	h.post("/api/fetch", `{"keep":true}`)
	<-b.started
	h.post("/api/forget", "{}")
	if f := h.wait(); f.State != stateCancelled || h.status().TokenHeld {
		t.Errorf("forget while fetching: %+v", f)
	}
}

func TestWrongToken(t *testing.T) {
	h := start(t, nil)
	h.login()
	h.post("/api/fetch", `{"token":"wrong-token-123","keep":true}`)
	f := h.wait()
	if f.State != stateFailed || !strings.Contains(f.Error, "rejected the token (HTTP 401)") || f.ResultReady {
		t.Errorf("%+v", f)
	}
	if h.status().TokenHeld {
		t.Error("a rejected token must be dropped")
	}
	if strings.Contains(h.seen.String()+h.log.String(), "wrong-token-123") {
		t.Error("the wrong token was shown")
	}
}

func TestTokenNeverLeaks(t *testing.T) {
	h := start(t, func(o *Options) { o.ForgetAfter = 0 })
	h.login()
	// An API that echoes the credentials in its errors.
	h.api.Intercept = func(w http.ResponseWriter, r *http.Request) bool {
		switch {
		case strings.HasSuffix(r.URL.Path, "/images"):
			fakeapi.WriteError(w, 403, "X", "you sent "+r.Header.Get("Authorization"))
		case strings.HasSuffix(r.URL.Path, "/labels"):
			fakeapi.WriteError(w, 400, "X", "token "+token+" invalid")
		default:
			return false
		}
		return true
	}
	h.post("/api/fetch", `{"token":"`+token+`","keep":true}`)
	if f := h.wait(); f.State != stateDone || f.Problems != 4 {
		t.Fatalf("%+v", f)
	}
	_, data := h.do(req{method: http.MethodPost, path: "/api/fetch/result", body: "{}"})
	snap, err := snapshot.Read(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	removed := 0
	for _, c := range snap.Manifest.Coverage {
		if strings.Contains(c.Error, "[credentials removed]") {
			removed++
		}
	}
	if removed != 2 {
		t.Errorf("%d scrubbed errors", removed)
	}
	h.post("/api/fetch", `{"token":"wrong-`+token+`","keep":true}`)
	h.wait()
	h.post("/api/forget", "{}")
	for name, s := range map[string]string{"responses": h.seen.String(), "log": h.log.String(), "snapshot": string(data)} {
		if strings.Contains(s, token) || strings.Contains(s, "SECRET-4f1c") {
			t.Errorf("the token is in the %s", name)
		}
	}
	if h.s.token != nil || h.status().TokenForgetAt != nil {
		t.Error("forget")
	}
}

func TestForgetZeroesTheToken(t *testing.T) {
	h := start(t, nil)
	h.login()
	h.post("/api/fetch", `{"token":"`+token+`","keep":true}`)
	h.wait()
	held := h.s.token
	if string(held) != token {
		t.Fatal("token not held")
	}
	h.post("/api/forget", "{}")
	if h.s.token != nil || strings.Trim(string(held), "\x00") != "" {
		t.Errorf("held bytes after forget: %q", held)
	}
	// Close (on exit) does the same.
	h.post("/api/fetch", `{"token":"`+token+`","keep":true}`)
	h.wait()
	held = h.s.token
	h.s.Close()
	if h.s.token != nil || strings.Trim(string(held), "\x00") != "" {
		t.Error("Close kept the token")
	}
	if code, _ := h.post("/api/fetch", `{"token":"`+token+`"}`); code != http.StatusServiceUnavailable {
		t.Errorf("fetch after Close: %d", code)
	}
}

func TestIdleForget(t *testing.T) {
	h := start(t, func(o *Options) { o.ForgetAfter = 150 * time.Millisecond })
	h.login()
	h.post("/api/fetch", `{"token":"`+token+`","keep":true}`)
	h.wait()
	if !h.status().TokenHeld {
		t.Fatal("token not held after the fetch")
	}
	time.Sleep(400 * time.Millisecond)
	if h.status().TokenHeld {
		t.Error("token held after the idle time")
	}
	if !strings.Contains(h.log.String(), "Token forgotten after 150ms unused") {
		t.Error(h.log.String())
	}
}

func TestMemoryOnly(t *testing.T) {
	// No snapshot folder, no temp files, no cache: nothing reaches the disk.
	dirs := map[string]string{"working directory": t.TempDir(), "TMPDIR": t.TempDir(), "HOME": t.TempDir(), "XDG_CACHE_HOME": t.TempDir()}
	t.Chdir(dirs["working directory"])
	for _, env := range []string{"TMPDIR", "HOME", "XDG_CACHE_HOME"} {
		t.Setenv(env, dirs[env])
	}
	h := start(t, nil)
	h.login()
	h.do(req{path: "/"})
	h.post("/api/fetch", `{"token":"`+token+`","keep":true}`)
	if f := h.wait(); f.State != stateDone {
		t.Fatal(f)
	}
	h.do(req{method: http.MethodPost, path: "/api/fetch/result", body: "{}"})
	h.post("/api/forget", "{}")
	for name, dir := range dirs {
		var found []string
		_ = filepath.WalkDir(dir, func(p string, _ os.DirEntry, _ error) error {
			if p != dir {
				found = append(found, p)
			}
			return nil
		})
		if len(found) > 0 {
			t.Errorf("%s: %v", name, found)
		}
	}
}

func TestListenAddresses(t *testing.T) {
	for addr, ok := range map[string]bool{
		"127.0.0.1:0": true, "localhost:8080": true, "[::1]:0": true, "127.0.0.2:80": true,
		"0.0.0.0:0": false, ":8080": false, "[::]:0": false, "192.168.1.10:80": false, "example.com:80": false, "127.0.0.1": false,
	} {
		if err := CheckListen(addr); (err == nil) != ok {
			t.Errorf("%s: %v", addr, err)
		}
	}
	for _, addr := range []string{"127.0.0.1:0", "0.0.0.0:8080", "nope"} {
		if _, err := New(Options{Addr: addr}); err == nil {
			t.Errorf("New(%s) accepted", addr)
		}
	}
	s, err := New(Options{Addr: "[::1]:8080"})
	if err != nil || s.LoginURL()[:24] != "http://[::1]:8080/login?" || !s.hosts["localhost:8080"] || !s.hosts["[::1]:8080"] {
		t.Errorf("%v %s %v", err, s.LoginURL(), s.hosts)
	}
	if _, err := New(Options{Addr: "127.0.0.1:8080", BaseURL: "ftp://x"}); err == nil {
		t.Error("bad base URL accepted")
	}
}

func TestCSPMatchesTheBuild(t *testing.T) {
	// The same policy as the static build's meta tag, so the two cannot drift.
	src, err := os.ReadFile("../../../explorer/vite.config.ts")
	if err != nil {
		t.Skip("explorer sources not found:", err)
	}
	block := regexp.MustCompile(`(?s)const csp = \[(.*?)\]\.join\('; '\)`).FindSubmatch(src)
	if block == nil {
		t.Fatal("no csp in vite.config.ts")
	}
	var parts []string
	for _, m := range regexp.MustCompile(`"([^"]+)"`).FindAllSubmatch(block[1], -1) {
		parts = append(parts, string(m[1]))
	}
	if got := strings.Join(parts, "; "); got != CSP {
		t.Errorf("vite.config.ts: %s\nserver:         %s", got, CSP)
	}
}
