package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeAuth logs in whoever /login?user=… names (tests only; package 02
// brings the real ones). Everything below /callback/ logs in "cb".
type fakeAuth struct{}

func (fakeAuth) Label() string    { return "Test login" }
func (fakeAuth) Routes() []string { return []string{"/login", "/callback/"} }

func (fakeAuth) ServeLogin(w http.ResponseWriter, r *http.Request, path string, done LoginFunc) {
	user := r.URL.Query().Get("user")
	if strings.HasPrefix(path, "/callback/") {
		user = "cb"
	}
	if user == "" {
		http.Error(w, "login page", http.StatusOK)
		return
	}
	done(w, r, Identity{Subject: "test:" + user, Name: "User " + user})
}

// clock is a settable time for the session TTLs.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

func startHosted(t *testing.T, publicURL string, mod func(*Options)) *harness {
	t.Helper()
	h := start(t, func(o *Options) {
		o.Hosted = &Hosted{PublicURL: publicURL, Auth: []Authenticator{fakeAuth{}}}
		if mod != nil {
			mod(o)
		}
	})
	h.origin, h.hostHeader, h.base = h.s.pub.origin, h.s.pub.host, h.s.pub.base
	return h
}

// client is another browser against the same server.
func (h *harness) client() *harness {
	c := &harness{t: h.t, s: h.s, url: h.url, host: h.host, api: h.api, log: h.log, origin: h.origin, hostHeader: h.hostHeader, base: h.base}
	return c
}

var sessionKeyMeta = regexp.MustCompile(`<meta name="ionos-explorer-session" content="([A-Za-z0-9_-]+)" />`)

// hostedLogin logs this client in as user and reads the key from the page.
func (h *harness) hostedLogin(user string) {
	h.t.Helper()
	resp, b := h.do(req{path: "/login?user=" + user})
	if resp.StatusCode != http.StatusSeeOther || resp.Header.Get("Location") != h.base+"/" || len(resp.Cookies()) != 1 {
		h.t.Fatalf("login: %d %v %s", resp.StatusCode, resp.Header, b)
	}
	h.cookie = resp.Cookies()[0]
	resp, b = h.do(req{path: "/"})
	m := sessionKeyMeta.FindSubmatch(b)
	if resp.StatusCode != http.StatusOK || m == nil {
		h.t.Fatalf("page after login: %d %s", resp.StatusCode, b)
	}
	h.key = string(m[1])
}

func TestPublicURL(t *testing.T) {
	for raw, want := range map[string]publicURL{
		"https://explorer.example.com":                    {origin: "https://explorer.example.com", host: "explorer.example.com", secure: true},
		"https://Explorer.Example.com:443/":               {origin: "https://explorer.example.com", host: "explorer.example.com", secure: true},
		"https://tools.example.com:8443/tools/ionos-x.1/": {origin: "https://tools.example.com:8443", host: "tools.example.com:8443", base: "/tools/ionos-x.1", secure: true},
		"http://localhost:8080":                           {origin: "http://localhost:8080", host: "localhost:8080"},
		"http://127.0.0.1/explorer":                       {origin: "http://127.0.0.1", host: "127.0.0.1", base: "/explorer"},
		"http://[::1]:8080":                               {origin: "http://[::1]:8080", host: "[::1]:8080"},
		"https://[2001:db8::1]/":                          {origin: "https://[2001:db8::1]", host: "[2001:db8::1]", secure: true},
	} {
		got, err := ParsePublicURL(raw)
		if err != nil || got != want {
			t.Errorf("%s: %+v %v", raw, got, err)
		}
	}
	for _, raw := range []string{
		"", "explorer.example.com", "/explorer", "http://explorer.example.com", "http://10.0.0.1:8080", "ftp://explorer.example.com",
		"https://user@explorer.example.com", "https://explorer.example.com/?a=1", "https://explorer.example.com/#x", "https://explorer.example.com?",
		"https://explorer.example.com/a//b", "https://explorer.example.com/a/../b", "https://explorer.example.com/a%2Fb", "https://explorer.example.com/a b",
		"https://explorer.example.com/./", "https:explorer",
	} {
		if got, err := ParsePublicURL(raw); err == nil {
			t.Errorf("%q accepted: %+v", raw, got)
		}
	}
}

// other is a second login method, at its own routes, that also ends the
// login at its provider.
type other struct{}

func (other) Label() string    { return "Other" }
func (other) Routes() []string { return []string{"/login/other", "/back/other"} }

func (other) ServeLogin(w http.ResponseWriter, r *http.Request, path string, done LoginFunc) {
	if path == "/login/other" {
		http.Redirect(w, r, "/back/other", http.StatusFound)
		return
	}
	done(w, r, Identity{Subject: "other:carol", Name: "Carol", LogoutHint: "hint-" + r.URL.Query().Get("hint")})
}

func (other) LogoutURL(id Identity, back string) string {
	return "https://idp.example/logout?hint=" + id.LogoutHint + "&back=" + back
}

type noRoutes struct{ fakeAuth }

func (noRoutes) Routes() []string { return nil }

type apiRoute struct{ fakeAuth }

func (apiRoute) Routes() []string { return []string{"/api/login"} }

func TestHostedConfig(t *testing.T) {
	for name, h := range map[string]Hosted{
		"no public URL":     {Auth: []Authenticator{fakeAuth{}}},
		"http public URL":   {PublicURL: "http://explorer.example.com", Auth: []Authenticator{fakeAuth{}}},
		"no login method":   {PublicURL: "https://explorer.example.com"},
		"no login routes":   {PublicURL: "https://explorer.example.com", Auth: []Authenticator{noRoutes{}}},
		"login under /api":  {PublicURL: "https://explorer.example.com", Auth: []Authenticator{apiRoute{}}},
		"same routes twice": {PublicURL: "https://explorer.example.com", Auth: []Authenticator{other{}, other{}}},
		"routes overlap":    {PublicURL: "https://explorer.example.com", Auth: []Authenticator{&prefixed{"/login/"}, other{}}},
		"nil method":        {PublicURL: "https://explorer.example.com", Auth: []Authenticator{nil}},
		"negative fetches":  {PublicURL: "https://explorer.example.com", Auth: []Authenticator{fakeAuth{}}, MaxFetches: -1},
		"negative idle":     {PublicURL: "https://explorer.example.com", Auth: []Authenticator{fakeAuth{}}, SessionIdle: -time.Second},
		"negative lifetime": {PublicURL: "https://explorer.example.com", Auth: []Authenticator{fakeAuth{}}, SessionTTL: -time.Second},
	} {
		if _, err := New(Options{Hosted: &h}); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// Any listen address: the address is not checked in hosted mode.
	in := &Hosted{PublicURL: "https://explorer.example.com", Auth: []Authenticator{fakeAuth{}}}
	s, err := New(Options{Addr: "0.0.0.0:8080", Hosted: in})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	h := s.opts.Hosted
	if h.MaxFetches != 2 || h.SessionTTL != 12*time.Hour || h.SessionIdle != 2*time.Hour || h.ResultTTL != 10*time.Minute || s.LoginURL() != "" {
		t.Errorf("defaults %+v, login URL %q", h, s.LoginURL())
	}
	if in.MaxFetches != 0 {
		t.Error("New changed the caller's options")
	}
}

func TestHostedCookie(t *testing.T) {
	for publicURL, want := range map[string]http.Cookie{
		"https://explorer.example":                   {Name: "__Host-ionos-explorer", Path: "/", Secure: true},
		"https://tools.example/tools/ionos-explorer": {Name: "__Secure-ionos-explorer", Path: "/tools/ionos-explorer", Secure: true},
		"http://localhost:8080":                      {Name: "ionos-explorer", Path: "/"},
	} {
		h := startHosted(t, publicURL, nil)
		h.hostedLogin("alice")
		c := h.cookie
		if c.Name != want.Name || c.Path != want.Path || c.Secure != want.Secure || !c.HttpOnly || c.SameSite != http.SameSiteLaxMode ||
			c.MaxAge != 0 || len(c.Value) < 40 || c.Value == h.key {
			t.Errorf("%s: %+v", publicURL, c)
		}
		// HSTS over https only.
		resp, _ := h.do(req{path: "/"})
		if hsts := resp.Header.Get("Strict-Transport-Security"); (hsts == "max-age=31536000") != want.Secure {
			t.Errorf("%s: HSTS %q", publicURL, hsts)
		}
	}
	// Local mode: never (plain http on loopback).
	if resp, _ := start(t, nil).do(req{path: "/"}); resp.Header.Get("Strict-Transport-Security") != "" {
		t.Error("HSTS in local mode")
	}
}

func TestHostedRoutes(t *testing.T) {
	h := startHosted(t, "https://tools.example/tools/ionos-explorer", nil)
	// Without a session: the page (it shows the login screen), without a key.
	resp, b := h.do(req{path: "/"})
	if resp.StatusCode != http.StatusOK || !bytes.Contains(b, []byte("<head>\n    "+HostedMarker+"<title>")) || bytes.Contains(b, []byte("ionos-explorer-session")) {
		t.Errorf("/ without session: %d %s", resp.StatusCode, b)
	}
	if resp, b := h.do(req{path: "/assets/index-abc.js"}); resp.StatusCode != http.StatusOK || !bytes.Contains(b, []byte("console.log")) {
		t.Errorf("asset without session: %d", resp.StatusCode)
	}
	if resp, b := h.do(req{path: "/api/status"}); resp.StatusCode != http.StatusUnauthorized || !bytes.Contains(b, []byte("log in again")) {
		t.Errorf("API without session: %d %s", resp.StatusCode, b)
	}
	// Only below the base path; the local login link does not exist.
	base := h.base
	h.base = ""
	for path, code := range map[string]int{
		"/": 404, "/api/status": 404, "/tools/ionos-explorer-other/": 404, "/tools/ionos-explorer": 301, "/tools/ionos-explorer/login?secret=x": 200,
		"/tools/ionos-explorer/callback/kc": 303, "/tools/ionos-explorer/callback": 404, "/tools/ionos-explorer/nope": 404,
	} {
		resp, _ := h.do(req{path: path})
		if resp.StatusCode != code {
			t.Errorf("%s: %d, want %d", path, resp.StatusCode, code)
		}
	}
	if resp, _ := h.do(req{path: "/tools/ionos-explorer"}); resp.Header.Get("Location") != "/tools/ionos-explorer/" {
		t.Errorf("redirect to %s", resp.Header.Get("Location"))
	}
	h.base = base
	if h.s.secret != "" {
		t.Error("hosted mode has a login secret")
	}

	h.hostedLogin("alice")
	resp, b = h.do(req{path: "/"})
	if !bytes.Contains(b, []byte("<head>\n    "+HostedMarker+"\n    "+`<meta name="ionos-explorer-session" content="`+h.key+`" /><title>`)) ||
		bytes.Contains(b, []byte(Marker)) || resp.Header.Get("Cache-Control") != "no-store" {
		t.Errorf("page: %v %s", resp.Header, b)
	}
	if resp, b := h.do(req{path: "/assets/sub/x.css"}); resp.StatusCode != http.StatusOK || string(b) != "body{}" {
		t.Errorf("asset: %d %s", resp.StatusCode, b)
	}
	if st := h.status(); st.User != "User alice" || st.TokenHeld {
		t.Errorf("%+v", st)
	}
}

func TestHostedSeveralMethods(t *testing.T) {
	h := startHosted(t, "https://tools.example/x", func(o *Options) {
		o.Hosted.Auth = []Authenticator{&prefixed{"/a/"}, other{}}
	})
	_, b := h.do(req{path: "/api/login-methods", noKey: true})
	if string(b) != `{"app":"ionos-explorer","local":false,"providers":[{"label":"Test login","url":"/x/a/"},{"label":"Other","url":"/x/login/other"}]}`+"\n" {
		t.Errorf("%s", b)
	}
	// Each route reaches its own method.
	if resp, b := h.do(req{path: "/a/login?user=alice"}); resp.StatusCode != http.StatusSeeOther {
		t.Errorf("first method: %d %s", resp.StatusCode, b)
	}
	resp, b := h.do(req{path: "/back/other?hint=1"})
	if resp.StatusCode != http.StatusSeeOther || len(resp.Cookies()) != 1 {
		t.Fatalf("second method: %d %s", resp.StatusCode, b)
	}
	h.cookie = resp.Cookies()[0]
	h.readKey()
	if st := h.status(); st.User != "Carol" || st.LocalUser || st.Admin {
		t.Errorf("%+v", st)
	}
	if strings.Contains(h.log.String(), "hint-1") {
		t.Error("the logout hint is in the log")
	}
	// Logout goes on to the provider, with the hint, and back.
	resp, b = h.do(req{method: http.MethodPost, path: "/api/logout", body: "{}"})
	var out struct{ Next string }
	if resp.StatusCode != http.StatusOK || json.Unmarshal(b, &out) != nil || out.Next != "https://idp.example/logout?hint=hint-1&back=https://tools.example/x/" {
		t.Errorf("logout: %d %s", resp.StatusCode, b)
	}
}

// prefixed is fakeAuth below its own prefix.
type prefixed struct{ prefix string }

func (p *prefixed) Label() string    { return "Test login" }
func (p *prefixed) Routes() []string { return []string{p.prefix} }
func (p *prefixed) ServeLogin(w http.ResponseWriter, r *http.Request, path string, done LoginFunc) {
	fakeAuth{}.ServeLogin(w, r, strings.TrimPrefix(path, p.prefix), done)
}

func TestHostedHostAndOrigin(t *testing.T) {
	h := startHosted(t, "https://explorer.example", nil)
	h.hostedLogin("alice")
	for _, host := range []string{h.host, "localhost", "evil.example", "explorer.example:443", "explorer.example.evil", ""} {
		for _, path := range []string{"/", "/login?user=bob", "/api/status"} {
			resp, b := h.do(req{path: path, header: map[string]string{"Host": host}})
			if resp.StatusCode != http.StatusMisdirectedRequest || len(resp.Cookies()) > 0 || bytes.Contains(b, []byte("explorer ui")) {
				t.Errorf("Host %q %s: %d", host, path, resp.StatusCode)
			}
		}
	}
	// X-Forwarded-* decide nothing.
	fwd := map[string]string{"Host": "evil.example", "X-Forwarded-Host": "explorer.example", "X-Forwarded-Proto": "https"}
	if resp, _ := h.do(req{path: "/api/status", header: fwd}); resp.StatusCode != http.StatusMisdirectedRequest {
		t.Errorf("X-Forwarded-Host trusted: %d", resp.StatusCode)
	}
	if resp, _ := h.do(req{path: "/api/status", header: map[string]string{"X-Forwarded-Host": "evil.example"}}); resp.StatusCode != http.StatusOK {
		t.Errorf("X-Forwarded-Host refused a good request: %d", resp.StatusCode)
	}
	if resp, _ := h.do(req{path: "/api/status", header: map[string]string{"Host": "EXPLORER.example"}}); resp.StatusCode != http.StatusOK {
		t.Errorf("Host in capitals: %d", resp.StatusCode)
	}
	for origin, want := range map[string]int{
		"https://explorer.example": 200, "http://explorer.example": 403, "https://explorer.example:8443": 403, "https://evil.example": 403,
		"http://" + h.host: 403, "": 403, "null": 403,
	} {
		resp, _ := h.do(req{method: http.MethodPost, path: "/api/forget", body: "{}", header: map[string]string{"Origin": origin}})
		if resp.StatusCode != want {
			t.Errorf("Origin %q: %d, want %d", origin, resp.StatusCode, want)
		}
	}
	if resp, _ := h.do(req{path: "/api/status", header: map[string]string{"Sec-Fetch-Site": "same-site"}}); resp.StatusCode != http.StatusForbidden {
		t.Errorf("same-site read: %d", resp.StatusCode)
	}
}

// gate holds every fake API request until opened (or the fetch is cancelled).
func gate(h *harness) chan struct{} {
	open := make(chan struct{})
	h.api.Intercept = func(w http.ResponseWriter, r *http.Request) bool {
		select {
		case <-open:
		case <-r.Context().Done():
		}
		return false
	}
	return open
}

func TestHostedSessionsAreSeparate(t *testing.T) {
	a := startHosted(t, "https://explorer.example", nil)
	b := a.client()
	a.hostedLogin("alice")
	b.hostedLogin("bob")
	if a.cookie.Value == b.cookie.Value || a.key == b.key {
		t.Fatal("two logins, one session")
	}
	open := gate(a)
	if code, body := a.post("/api/fetch", `{"token":"`+token+`","keep":true}`); code != http.StatusAccepted {
		t.Fatal(code, body)
	}
	if st := b.status(); st.Fetch != nil || st.TokenHeld || st.User != "User bob" {
		t.Errorf("bob sees alice's fetch: %+v", st)
	}
	if code, body := b.post("/api/fetch", `{"token":"`+token+`","keep":false}`); code != http.StatusAccepted {
		t.Fatal(code, body)
	}
	// Alice's cookie with Bob's key, and the other way round.
	mixed := a.client()
	mixed.cookie, mixed.key = a.cookie, b.key
	if resp, _ := mixed.do(req{path: "/api/status"}); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("alice's cookie, bob's key: %d", resp.StatusCode)
	}
	mixed.cookie, mixed.key = b.cookie, a.key
	if code, _ := mixed.post("/api/fetch/cancel", "{}"); code != http.StatusUnauthorized {
		t.Errorf("bob's cookie, alice's key: %d", code)
	}
	close(open)
	fa, fb := a.wait(), b.wait()
	if fa.State != stateDone || fb.State != stateDone || !fa.ResultReady || !fb.ResultReady {
		t.Fatalf("%+v %+v", fa, fb)
	}
	if !a.status().TokenHeld || b.status().TokenHeld {
		t.Error("keep is per session")
	}
	resp, data := a.do(req{method: http.MethodPost, path: "/api/fetch/result", body: "{}"})
	if resp.StatusCode != http.StatusOK || len(data) == 0 || a.status().Fetch.ResultReady {
		t.Fatalf("alice's result: %d", resp.StatusCode)
	}
	if !b.status().Fetch.ResultReady {
		t.Error("taking alice's result dropped bob's")
	}
	a.post("/api/forget", "{}")
	if a.status().TokenHeld {
		t.Error("forget")
	}
}

func TestHostedFetchLimit(t *testing.T) {
	a := startHosted(t, "https://explorer.example", func(o *Options) { o.Hosted.MaxFetches = 2 })
	b, c := a.client(), a.client()
	a.hostedLogin("a")
	b.hostedLogin("b")
	c.hostedLogin("c")
	open := gate(a)
	defer close(open)
	for _, h := range []*harness{a, b} {
		if code, body := h.post("/api/fetch", `{"token":"`+token+`","keep":true}`); code != http.StatusAccepted {
			t.Fatal(code, body)
		}
	}
	code, body := c.post("/api/fetch", `{"token":"`+token+`","keep":true}`)
	if code != http.StatusTooManyRequests || !strings.Contains(body, "2 fetches are running, try again in a minute") {
		t.Fatalf("third fetch: %d %s", code, body)
	}
	if st := c.status(); st.Fetch != nil || !st.TokenHeld {
		t.Errorf("refused fetch: %+v (the token is kept for the retry when asked)", st)
	}
	if code, _ := c.post("/api/fetch", `{"token":"`+token+`","keep":false}`); code != http.StatusTooManyRequests || c.status().TokenHeld {
		t.Error("a refused fetch without keep must drop the token")
	}
	a.post("/api/fetch/cancel", "{}")
	if f := a.wait(); f.State != stateCancelled {
		t.Fatal(f)
	}
	if code, body := c.post("/api/fetch", `{"token":"`+token+`","keep":true}`); code != http.StatusAccepted {
		t.Errorf("after one ended: %d %s", code, body)
	}
}

func TestHostedSessionExpiry(t *testing.T) {
	clk := &clock{t: time.Date(2026, 10, 16, 8, 0, 0, 0, time.UTC)}
	h := startHosted(t, "https://explorer.example", func(o *Options) { o.now = clk.now })
	h.hostedLogin("alice")
	open := gate(h)
	defer close(open)
	h.post("/api/fetch", `{"token":"`+token+`","keep":true}`)
	h.s.mu.Lock()
	var ss *session
	for _, s := range h.s.sessions {
		ss = s
	}
	held, j := ss.token, ss.job
	h.s.mu.Unlock()

	clk.add(2*time.Hour - time.Second)
	h.s.sweep()
	if !h.status().TokenHeld {
		t.Fatal("ended before the idle time")
	}
	clk.add(2 * time.Hour)
	h.s.sweep()
	if resp, _ := h.do(req{path: "/api/status"}); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("idle session still open: %d", resp.StatusCode)
	}
	if _, b := h.do(req{path: "/"}); bytes.Contains(b, []byte("ionos-explorer-session")) {
		t.Error("page of an idle session has a key")
	}
	h.s.mu.Lock()
	gone, n := ss.gone, len(h.s.sessions)
	h.s.mu.Unlock()
	if !gone || n != 0 || strings.Trim(string(held), "\x00") != "" {
		t.Errorf("session not dropped (%d left) or token not zeroed", n)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		h.s.mu.Lock()
		state, running := j.State, h.s.running
		h.s.mu.Unlock()
		if state == stateCancelled && running == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("job %s, %d running", state, running)
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !strings.Contains(h.log.String(), "test:alice] Session expired.") {
		t.Error(h.log.String())
	}

	// Lifetime: in use all along, still over after 12 hours, without a sweep.
	h.hostedLogin("alice")
	for range 11 {
		clk.add(time.Hour)
		h.status() // fails the test when refused

	}
	clk.add(time.Hour)
	if resp, _ := h.do(req{path: "/api/status"}); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("session past its lifetime: %d", resp.StatusCode)
	}
}

func TestHostedResultNotTaken(t *testing.T) {
	clk := &clock{t: time.Date(2026, 10, 16, 8, 0, 0, 0, time.UTC)}
	h := startHosted(t, "https://explorer.example", func(o *Options) { o.now = clk.now })
	h.hostedLogin("alice")
	h.post("/api/fetch", `{"token":"`+token+`"}`)
	if f := h.wait(); !f.ResultReady {
		t.Fatal(f)
	}
	clk.add(9 * time.Minute)
	h.s.sweep()
	if !h.status().Fetch.ResultReady {
		t.Fatal("dropped too early")
	}
	clk.add(time.Minute)
	h.s.sweep()
	if h.status().Fetch.ResultReady {
		t.Error("an untaken result is kept")
	}
	if !strings.Contains(h.log.String(), "not taken within 10m0s; dropped") {
		t.Error(h.log.String())
	}
}

func TestHostedLoginRotatesAndLogoutEnds(t *testing.T) {
	a := startHosted(t, "https://explorer.example", nil)
	b := a.client()
	a.hostedLogin("alice")
	b.hostedLogin("bob")
	old := a.client()
	old.cookie, old.key = a.cookie, a.key
	// A new login in the same browser replaces its session.
	a.hostedLogin("alice")
	if resp, _ := old.do(req{path: "/api/status"}); resp.StatusCode != http.StatusUnauthorized || a.cookie.Value == old.cookie.Value {
		t.Errorf("old session still open: %d", resp.StatusCode)
	}
	a.status()

	resp, body := a.do(req{method: http.MethodPost, path: "/api/logout", body: "{}"})
	var out struct{ Next string }
	if resp.StatusCode != http.StatusOK || json.Unmarshal(body, &out) != nil || out.Next != "/" {
		t.Fatalf("logout: %d %s", resp.StatusCode, body)
	}
	if c := resp.Cookies(); len(c) != 1 || c[0].Name != "__Host-ionos-explorer" || c[0].Value != "" || c[0].MaxAge >= 0 {
		t.Errorf("cookie not cleared: %v", c)
	}
	if resp, _ := a.do(req{path: "/api/status"}); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("after logout: %d", resp.StatusCode)
	}
	if b.status().User != "User bob" {
		t.Error("logout ended another session")
	}
	// The logout needs the key like every other change.
	if resp, _ := b.do(req{method: http.MethodPost, path: "/api/logout", body: "{}", noKey: true}); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("logout without key: %d", resp.StatusCode)
	}

	// Local mode has nothing to log out of.
	l := start(t, nil)
	l.login()
	if code, _ := l.post("/api/logout", "{}"); code != http.StatusNotFound {
		t.Errorf("local logout: %d", code)
	}
}

func TestHostedLogLines(t *testing.T) {
	h := startHosted(t, "https://explorer.example", nil)
	h.hostedLogin("alice")
	h.post("/api/fetch", `{"token":"`+token+`"}`)
	h.wait()
	h.do(req{method: http.MethodPost, path: "/api/fetch/result", body: "{}"})
	log := h.log.String()
	if !regexp.MustCompile(`\[[0-9a-f]{8} test:alice\] Logged in\.`).MatchString(log) ||
		!regexp.MustCompile(`\[[0-9a-f]{8} test:alice\] Snapshot handed to the browser`).MatchString(log) {
		t.Error(log)
	}
	for name, secret := range map[string]string{"token": token, "cookie": h.cookie.Value, "key": h.key} {
		if strings.Contains(log, secret) {
			t.Errorf("the %s is in the log", name)
		}
	}
	if got := printable("evil\n12:00:00 [x admin] Logged in.\x1b[2J"); strings.ContainsAny(got, "\n\x1b ") {
		t.Errorf("%q", got)
	}
	if got := printable(strings.Repeat("ä", 100)); got != strings.Repeat("ä", 80)+"…" {
		t.Errorf("%q", got)
	}
}
