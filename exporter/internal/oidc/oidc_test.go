package oidc

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/K4ugummi/ionos-explorer/exporter/internal/server"
)

const publicURL = "https://explorer.example/tools"

// logBuffer is a log the providers' goroutines may write to.
type logBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *logBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *logBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

type harness struct {
	t   *testing.T
	idp *fakeIdP
	p   *Provider
	log *logBuffer
	got *server.Identity
}

func newHarness(t *testing.T, id string, mod func(*Config)) *harness {
	t.Helper()
	h := &harness{t: t, idp: newFakeIdP(t), log: &logBuffer{}}
	cfg := Config{ID: id, Name: "Test IdP", Issuer: h.idp.URL(), ClientID: clientID, ClientSecret: clientSecret}
	if mod != nil {
		mod(&cfg)
	}
	p, err := New(cfg, Options{PublicURL: publicURL, Client: h.idp.srv.Client(), Log: server.NewLogger(h.log, false)})
	if err != nil {
		t.Fatal(err)
	}
	h.p = p
	return h
}

func (h *harness) serve(path string, cookie *http.Cookie) *httptest.ResponseRecorder {
	h.t.Helper()
	r := httptest.NewRequest(http.MethodGet, "https://explorer.example/tools"+path, nil)
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	h.got = nil
	h.p.ServeLogin(w, r, strings.SplitN(path, "?", 2)[0], func(w http.ResponseWriter, r *http.Request, id server.Identity) {
		h.got = &id
		w.WriteHeader(http.StatusSeeOther)
	})
	return w
}

// begin opens the button's route: the attempt's cookie and where it sends
// the browser.
func (h *harness) begin() (*http.Cookie, string) {
	h.t.Helper()
	w := h.serve("/login/"+h.p.ID(), nil)
	loc := w.Header().Get("Location")
	cookies := w.Result().Cookies()
	if w.Code != http.StatusFound || !strings.HasPrefix(loc, h.idp.URL()+"/authorize?") || len(cookies) != 1 {
		h.t.Fatalf("login: %d %v %s", w.Code, w.Header(), w.Body)
	}
	return cookies[0], loc
}

// authorize asks the identity provider, which logs its User in at once:
// the callback it sends the browser to, below the base path.
func (h *harness) authorize(loc string) string {
	h.t.Helper()
	client := *h.idp.srv.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Get(loc)
	if err != nil {
		h.t.Fatal(err)
	}
	resp.Body.Close()
	back := resp.Header.Get("Location")
	if resp.StatusCode != http.StatusFound || !strings.HasPrefix(back, publicURL+"/callback/"+h.p.ID()+"?") {
		h.t.Fatalf("authorize: %d %s", resp.StatusCode, back)
	}
	return strings.TrimPrefix(back, publicURL)
}

// login runs a whole login and answers the callback's response.
func (h *harness) login() *httptest.ResponseRecorder {
	h.t.Helper()
	cookie, loc := h.begin()
	return h.serve(h.authorize(loc), cookie)
}

func (h *harness) wantRefused(w *httptest.ResponseRecorder, code int, text string) {
	h.t.Helper()
	if h.got != nil || w.Code != code || !strings.Contains(w.Body.String(), text) {
		h.t.Errorf("%d %v %s", w.Code, h.got, w.Body)
	}
}

func TestLogin(t *testing.T) {
	h := newHarness(t, "kc", nil)
	cookie, loc := h.begin()
	// The attempt's cookie: only for this provider's callback, Lax, Secure,
	// sealed (no state or verifier to read in it).
	if cookie.Name != "__Secure-ionos-explorer-login-kc" || cookie.Path != "/tools/callback/kc" || !cookie.HttpOnly || !cookie.Secure ||
		cookie.SameSite != http.SameSiteLaxMode || cookie.MaxAge != 600 {
		t.Errorf("cookie %+v", cookie)
	}
	u, _ := url.Parse(loc)
	q := u.Query()
	if q.Get("client_id") != clientID || q.Get("redirect_uri") != publicURL+"/callback/kc" || q.Get("scope") != "openid profile email" ||
		q.Get("code_challenge_method") != "S256" || len(q.Get("state")) < 43 || len(q.Get("nonce")) < 43 {
		t.Errorf("authorization request %v", q)
	}
	plain, _ := base64.RawURLEncoding.DecodeString(cookie.Value)
	if bytes.Contains(plain, []byte(q.Get("state"))) || bytes.Contains(plain, []byte("\"s\"")) {
		t.Error("the cookie is readable")
	}
	w := h.serve(h.authorize(loc), cookie)
	if w.Code != http.StatusSeeOther || h.got == nil {
		t.Fatalf("callback: %d %s", w.Code, w.Body)
	}
	if h.got.Subject != "oidc:kc:u-1" || h.got.Name != "Alice" || h.got.Admin || !strings.HasPrefix(h.got.LogoutHint, "ey") {
		t.Errorf("identity %+v", h.got)
	}
	if c := w.Result().Cookies(); len(c) != 1 || c[0].Name != cookie.Name || c[0].MaxAge >= 0 {
		t.Errorf("attempt cookie not cleared: %v", c)
	}
	// Logout at the provider, with the ID token, back to the explorer.
	lo, _ := url.Parse(h.p.LogoutURL(*h.got, publicURL+"/"))
	if lo.Host != strings.TrimPrefix(h.idp.URL(), "https://") || lo.Path != "/logout" || lo.Query().Get("id_token_hint") != h.got.LogoutHint ||
		lo.Query().Get("post_logout_redirect_uri") != publicURL+"/" || lo.Query().Get("client_id") != clientID {
		t.Errorf("logout URL %s", lo)
	}
	if err := h.p.Ready(); err != nil {
		t.Error(err)
	}
	// Name falls back to the username, the email, the subject.
	h.idp.User = map[string]any{"sub": "u-2", "preferred_username": "bob"}
	if h.login(); h.got == nil || h.got.Name != "bob" {
		t.Errorf("%+v", h.got)
	}
	h.idp.User = map[string]any{"sub": "u-3"}
	if h.login(); h.got == nil || h.got.Name != "u-3" {
		t.Errorf("%+v", h.got)
	}
}

func TestLoginRefusals(t *testing.T) {
	h := newHarness(t, "kc", nil)
	expired := "This login has expired"

	// Wrong state; no cookie; a cookie from another attempt.
	cookie, loc := h.begin()
	back := h.authorize(loc)
	h.wantRefused(h.serve(strings.Replace(back, "state=", "state=x", 1), cookie), http.StatusBadRequest, expired)
	cookie, loc = h.begin()
	back = h.authorize(loc)
	h.wantRefused(h.serve(back, nil), http.StatusBadRequest, expired)
	other, _ := h.begin()
	h.wantRefused(h.serve(back, other), http.StatusBadRequest, expired)
	// A forged cookie.
	h.wantRefused(h.serve(back, &http.Cookie{Name: cookie.Name, Value: "eyJwIjoia2MifQ"}), http.StatusBadRequest, expired)

	// Replayed: the same answer again, the same code again.
	if h.serve(back, cookie); h.got == nil {
		t.Fatal("login failed")
	}
	h.wantRefused(h.serve(back, cookie), http.StatusBadRequest, expired)
	cookie2, loc := h.begin()
	back = h.authorize(loc)
	code := param(back, "code")
	if h.serve(back, cookie2); h.got == nil {
		t.Fatal("login failed")
	}
	cookie3, loc := h.begin()
	state := param(h.authorize(loc), "state")
	h.wantRefused(h.serve("/callback/kc?code="+code+"&state="+state, cookie3), http.StatusBadGateway, "failed")

	// Expired attempt (10 minutes).
	cookie, loc = h.begin()
	back = h.authorize(loc)
	h.p.now = func() time.Time { return time.Now().Add(11 * time.Minute) }
	h.wantRefused(h.serve(back, cookie), http.StatusBadRequest, expired)
	h.p.now = time.Now

	// An error from the provider: escaped and short.
	cookie, _ = h.begin()
	w := h.serve("/callback/kc?error=access_denied&error_description="+url.QueryEscape("<script>x</script>"+strings.Repeat("a", 500)), cookie)
	h.wantRefused(w, http.StatusBadRequest, "access_denied: &lt;script&gt;")
	if strings.Contains(w.Body.String(), "<script>") || strings.Count(w.Body.String(), "a") > 300 {
		t.Errorf("not escaped or not cut: %s", w.Body)
	}
	// Another issuer in the answer (RFC 9207).
	cookie, loc = h.begin()
	h.wantRefused(h.serve(h.authorize(loc)+"&iss=https://evil.example", cookie), http.StatusBadGateway, "failed")
	if !strings.Contains(h.log.String(), `names issuer "https://evil.example"`) {
		t.Error(h.log.String())
	}
}

// param is a query parameter of a path or URL.
func param(s, name string) string {
	u, _ := url.Parse(s)
	return u.Query().Get(name)
}

// hs256 signs claims with a shared key, as a provider would with HS256.
func hs256(claims []byte, key string) string {
	in := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`)) + "." + base64.RawURLEncoding.EncodeToString(claims)
	m := hmac.New(sha256.New, []byte(key))
	m.Write([]byte(in))
	return in + "." + base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func TestTokenChecks(t *testing.T) {
	h := newHarness(t, "kc", nil)
	for name, tamper := range map[string]func(map[string]any){
		"wrong nonce":         func(c map[string]any) { c["nonce"] = "x" },
		"no nonce":            func(c map[string]any) { delete(c, "nonce") },
		"wrong audience":      func(c map[string]any) { c["aud"] = "other" },
		"several, no azp":     func(c map[string]any) { c["aud"] = []string{clientID, "other"} },
		"azp of another":      func(c map[string]any) { c["aud"] = []string{clientID, "other"}; c["azp"] = "other" },
		"wrong issuer":        func(c map[string]any) { c["iss"] = "https://evil.example" },
		"expired":             func(c map[string]any) { c["exp"] = time.Now().Add(-3 * time.Minute).Unix() },
		"issued in future":    func(c map[string]any) { c["iat"] = time.Now().Add(5 * time.Minute).Unix() },
		"no iat":              func(c map[string]any) { delete(c, "iat") },
		"no subject":          func(c map[string]any) { delete(c, "sub") },
		"not before, far off": func(c map[string]any) { c["nbf"] = time.Now().Add(time.Hour).Unix() },
	} {
		h.idp.Tamper = tamper
		h.wantRefused(h.login(), http.StatusBadGateway, "failed")
		if t.Failed() {
			t.Fatal(name)
		}
	}
	// Within the allowed skew: taken.
	h.idp.Tamper = func(c map[string]any) {
		c["exp"] = time.Now().Add(-time.Minute).Unix()
		c["iat"] = time.Now().Add(time.Minute).Unix()
	}
	if h.login(); h.got == nil {
		t.Error("refused within the skew")
	}
	// Several audiences with azp of this client: taken.
	h.idp.Tamper = func(c map[string]any) { c["aud"] = []string{clientID, "other"}; c["azp"] = clientID }
	if h.login(); h.got == nil {
		t.Error("refused with azp")
	}

	// alg none, and HS256 with the client secret as key.
	h.idp.Sign = func(claims []byte) string {
		return base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`)) + "." + base64.RawURLEncoding.EncodeToString(claims) + "."
	}
	h.wantRefused(h.login(), http.StatusBadGateway, "failed")
	h.idp.Sign = func(claims []byte) string { return hs256(claims, clientSecret) }
	h.wantRefused(h.login(), http.StatusBadGateway, "failed")
	// A key the provider does not publish.
	h.idp.Sign = func(claims []byte) string {
		stranger := newFakeIdP(t)
		return h.idp.signWith(stranger.key, h.idp.kid, claims)
	}
	h.wantRefused(h.login(), http.StatusBadGateway, "failed")
	// A rotated key: fetched when a token names it.
	h.idp.rotate()
	if h.login(); h.got == nil {
		t.Errorf("refused after a key rotation: %s", h.log)
	}
	if strings.Contains(h.log.String(), "eyJ") {
		t.Errorf("a token in the log: %s", h.log)
	}
}

func TestPKCE(t *testing.T) {
	h := newHarness(t, "kc", nil)
	cookie, loc := h.begin()
	back := h.authorize(loc)
	// The same attempt with another verifier: the provider refuses the code.
	a, err := h.p.open(cookie.Value)
	if err != nil || len(a.Verifier) < 43 {
		t.Fatalf("%+v %v", a, err)
	}
	a.Verifier = "wrong-verifier-wrong-verifier-wrong-verifier-wrong"
	forged := &http.Cookie{Name: cookie.Name, Value: h.p.seal(a)}
	h.wantRefused(h.serve(back, forged), http.StatusBadGateway, "failed")
	if !strings.Contains(h.log.String(), "invalid_grant") {
		t.Error(h.log.String())
	}
}

func TestTwoProviders(t *testing.T) {
	a := newHarness(t, "a", nil)
	b := newHarness(t, "b", nil)
	// The state and cookie of A's attempt at B's callback.
	cookie, loc := a.begin()
	back := strings.Replace(a.authorize(loc), "/callback/a", "/callback/b", 1)
	c := *cookie
	c.Name = "__Secure-ionos-explorer-login-b"
	b.wantRefused(b.serve(back, &c), http.StatusBadRequest, "expired")
	// Each on its own.
	if a.login(); a.got == nil || a.got.Subject != "oidc:a:u-1" {
		t.Errorf("%+v", a.got)
	}
	if b.login(); b.got == nil || b.got.Subject != "oidc:b:u-1" {
		t.Errorf("%+v", b.got)
	}
}

func TestAllowLists(t *testing.T) {
	h := newHarness(t, "kc", func(c *Config) {
		c.AllowedGroups = []string{"explorer"}
		c.AllowedEmails = []string{"@example.com", "Boss@Other.Example"}
		c.AdminGroups = []string{"explorer-admins"}
	})
	for name, tc := range map[string]struct {
		user         map[string]any
		allow, admin bool
	}{
		"group":                 {map[string]any{"sub": "1", "groups": []string{"x", "explorer"}}, true, false},
		"group as one string":   {map[string]any{"sub": "1", "groups": "explorer"}, true, false},
		"other group":           {map[string]any{"sub": "1", "groups": []string{"explorers"}}, false, false},
		"admin group":           {map[string]any{"sub": "1", "groups": []string{"explorer-admins"}}, true, true},
		"domain":                {map[string]any{"sub": "1", "email": "Carol@Example.com", "email_verified": true}, true, false},
		"domain, as string":     {map[string]any{"sub": "1", "email": "carol@example.com", "email_verified": "true"}, true, false},
		"domain, not verified":  {map[string]any{"sub": "1", "email": "carol@example.com", "email_verified": false}, false, false},
		"domain, \"false\"":     {map[string]any{"sub": "1", "email": "carol@example.com", "email_verified": "false"}, false, false},
		"domain, no verified":   {map[string]any{"sub": "1", "email": "carol@example.com"}, false, false},
		"look-alike domain":     {map[string]any{"sub": "1", "email": "carol@evil-example.com", "email_verified": true}, false, false},
		"subdomain":             {map[string]any{"sub": "1", "email": "carol@mail.example.com", "email_verified": true}, false, false},
		"address":               {map[string]any{"sub": "1", "email": "boss@other.example", "email_verified": true}, true, false},
		"other address":         {map[string]any{"sub": "1", "email": "bossy@other.example", "email_verified": true}, false, false},
		"nothing":               {map[string]any{"sub": "1"}, false, false},
		"group in another type": {map[string]any{"sub": "1", "groups": map[string]any{"explorer": true}}, false, false},
	} {
		h.idp.User = tc.user
		w := h.login()
		switch {
		case tc.allow && (h.got == nil || h.got.Admin != tc.admin):
			t.Errorf("%s: %d %+v %s", name, w.Code, h.got, w.Body)
		case !tc.allow && (h.got != nil || w.Code != http.StatusForbidden):
			t.Errorf("%s: allowed %+v", name, h.got)
		}
	}
	h.idp.User = map[string]any{"sub": "1", "name": "Mallory <b>"}
	w := h.login()
	if !strings.Contains(w.Body.String(), "as Mallory &lt;b&gt;") || !strings.Contains(w.Body.String(), "Log out at Test IdP") {
		t.Errorf("%s", w.Body)
	}
	if !strings.Contains(h.log.String(), "Login refused for oidc:kc:1 (Mallory <b>)") {
		t.Error(h.log.String())
	}

	// Another claim, nested (Keycloak's realm roles); Entra ID's overage.
	h = newHarness(t, "kc", func(c *Config) {
		c.GroupsClaim = "realm_access.roles"
		c.AllowedGroups = []string{"explorer"}
	})
	h.idp.User = map[string]any{"sub": "1", "realm_access": map[string]any{"roles": []string{"explorer"}}}
	if h.login(); h.got == nil {
		t.Error("nested claim")
	}
	h = newHarness(t, "kc", func(c *Config) { c.AllowedGroups = []string{"g"} })
	h.idp.User = map[string]any{"sub": "1", "_claim_names": map[string]any{"groups": "src1"}, "_claim_sources": map[string]any{"src1": map[string]any{"endpoint": "https://graph.example"}}}
	if h.login(); h.got != nil || !strings.Contains(h.log.String(), "too many") {
		t.Errorf("overage: %+v %s", h.got, h.log)
	}

	// No lists: everyone; said in the log at the start.
	h = newHarness(t, "kc", nil)
	h.p.Start(context.Background())
	h.idp.User = map[string]any{"sub": "1"}
	if h.login(); h.got == nil {
		t.Error("refused without lists")
	}
	if !strings.Contains(h.log.String(), "everyone it lets log in") {
		t.Error(h.log.String())
	}
}

func TestProviderDown(t *testing.T) {
	h := newHarness(t, "kc", nil)
	h.idp.srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h.p.Start(ctx)
	deadline := time.Now().Add(5 * time.Second)
	for h.p.Ready() == nil || h.p.Ready().Error() == "not reached yet" {
		if time.Now().After(deadline) {
			t.Fatal("no discovery attempt")
		}
		time.Sleep(5 * time.Millisecond)
	}
	w := h.serve("/login/kc", nil)
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "cannot be reached") || len(w.Result().Cookies()) != 0 {
		t.Errorf("%d %s", w.Code, w.Body)
	}
	if h.p.LogoutURL(server.Identity{}, publicURL) != "" {
		t.Error("a logout URL without discovery")
	}
	if !strings.Contains(h.log.String(), "Login provider kc: discovery at") {
		t.Error(h.log.String())
	}
}

func TestConfig(t *testing.T) {
	idp := newFakeIdP(t)
	ok := Config{ID: "kc", Issuer: idp.URL(), ClientID: "c", ClientSecret: "s"}
	for name, mod := range map[string]func(*Config){
		"bad ID":          func(c *Config) { c.ID = "Key Cloak" },
		"long ID":         func(c *Config) { c.ID = strings.Repeat("a", 33) },
		"no issuer":       func(c *Config) { c.Issuer = "" },
		"http issuer":     func(c *Config) { c.Issuer = "http://idp.example" },
		"issuer query":    func(c *Config) { c.Issuer = "https://idp.example/?x=1" },
		"no client":       func(c *Config) { c.ClientID = "" },
		"no secret":       func(c *Config) { c.ClientSecret = "" },
		"bad email":       func(c *Config) { c.AllowedEmails = []string{"example.com"} },
		"empty domain":    func(c *Config) { c.AllowedEmails = []string{"a@"} },
		"relative issuer": func(c *Config) { c.Issuer = "/realms/x" },
	} {
		c := ok
		c.Issuer = "https://idp.example/realms/x"
		mod(&c)
		if _, err := New(c, Options{PublicURL: publicURL}); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// http issuer only for a trial on localhost.
	c := ok
	c.Issuer = "http://keycloak.localhost:8180/realms/test"
	if _, err := New(c, Options{PublicURL: "http://localhost:8080"}); err != nil {
		t.Error(err)
	}
	p, err := New(Config{ID: "x", Issuer: "https://idp.example", ClientID: "c", ClientSecret: "s", Scopes: []string{"email"}}, Options{PublicURL: "http://localhost:8080"})
	if err != nil || strings.Join(p.cfg.Scopes, " ") != "openid email" || p.Label() != "x" || p.cookie.Name != "ionos-explorer-login-x" || p.cookie.Secure || p.cookie.Path != "/callback/x" {
		t.Errorf("%+v %v", p, err)
	}

	// Discovery that offers only algorithms the explorer does not take.
	h := newHarness(t, "kc", nil)
	h.idp.Algs = []string{"HS256", "none"}
	w := h.serve("/login/kc", nil)
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(h.p.Ready().Error(), "signs ID tokens only with HS256, none") {
		t.Errorf("%d %v", w.Code, h.p.Ready())
	}
}

func TestOnlyGet(t *testing.T) {
	h := newHarness(t, "kc", nil)
	r := httptest.NewRequest(http.MethodPost, publicURL+"/login/kc", nil)
	w := httptest.NewRecorder()
	h.p.ServeLogin(w, r, "/login/kc", nil)
	if w.Code != http.StatusMethodNotAllowed {
		t.Error(w.Code)
	}
}

// The whole way through the server, below a base path: button, identity
// provider, callback, session, logout at the provider.
func TestThroughTheServer(t *testing.T) {
	idp := newFakeIdP(t)
	log := &logBuffer{}
	p, err := New(Config{ID: "kc", Name: "Keycloak", Issuer: idp.URL(), ClientID: clientID, ClientSecret: clientSecret},
		Options{PublicURL: publicURL, Client: idp.srv.Client(), Log: server.NewLogger(log, false)})
	if err != nil {
		t.Fatal(err)
	}
	srv, err := server.New(server.Options{Hosted: &server.Hosted{PublicURL: publicURL, Auth: []server.Authenticator{p}},
		UI: fstest.MapFS{"index.html": {Data: []byte("<!doctype html><html><head><title>x</title></head></html>")}}, Log: log})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	ts := httptest.NewServer(srv)
	defer ts.Close()
	do := func(method, path string, cookie *http.Cookie, header map[string]string) (*http.Response, string) {
		t.Helper()
		var body io.Reader
		if method == http.MethodPost {
			body = strings.NewReader("{}")
		}
		req, _ := http.NewRequest(method, ts.URL+path, body)
		req.Host = "explorer.example"
		if cookie != nil {
			req.AddCookie(cookie)
		}
		for k, v := range header {
			req.Header.Set(k, v)
		}
		resp, err := http.DefaultTransport.RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp, string(b)
	}

	resp, b := do(http.MethodGet, "/tools/api/login-methods", nil, nil)
	if !strings.Contains(b, `"providers":[{"label":"Keycloak","url":"/tools/login/kc","unavailable":true}]`) {
		t.Errorf("before discovery: %s", b)
	}
	resp, _ = do(http.MethodGet, "/tools/login/kc", nil, nil)
	if resp.StatusCode != http.StatusFound || len(resp.Cookies()) != 1 {
		t.Fatalf("login: %d", resp.StatusCode)
	}
	attempt := resp.Cookies()[0]
	h := &harness{t: t, idp: idp, p: p}
	back := h.authorize(resp.Header.Get("Location"))
	if !strings.HasPrefix("/tools"+back, attempt.Path+"?") {
		t.Errorf("the browser would not send the cookie (path %s) to %s", attempt.Path, back)
	}
	resp, b = do(http.MethodGet, "/tools"+back, attempt, nil)
	var session *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == "__Secure-ionos-explorer" {
			session = c
		}
	}
	if resp.StatusCode != http.StatusSeeOther || resp.Header.Get("Location") != "/tools/" || session == nil {
		t.Fatalf("callback: %d %v %s", resp.StatusCode, resp.Header, b)
	}
	_, page := do(http.MethodGet, "/tools/", session, nil)
	key := regexp.MustCompile(`ionos-explorer-session" content="([^"]+)"`).FindStringSubmatch(page)
	if key == nil {
		t.Fatalf("no key: %s", page)
	}
	hdr := map[string]string{server.Header: key[1], "Origin": "https://explorer.example", "Content-Type": "application/json"}
	if _, b := do(http.MethodGet, "/tools/api/status", session, hdr); !strings.Contains(b, `"user":"Alice"`) || strings.Contains(b, `"localUser":true`) {
		t.Errorf("status: %s", b)
	}
	if _, b := do(http.MethodGet, "/tools/api/login-methods", nil, nil); strings.Contains(b, "unavailable") {
		t.Errorf("after discovery: %s", b)
	}
	resp, b = do(http.MethodPost, "/tools/api/logout", session, hdr)
	if resp.StatusCode != http.StatusOK || !strings.Contains(b, `"next":"`+idp.URL()+`/logout?`) ||
		!strings.Contains(b, url.QueryEscape(publicURL+"/")) || !strings.Contains(b, "id_token_hint=ey") {
		t.Errorf("logout: %d %s", resp.StatusCode, b)
	}
	if strings.Contains(log.String(), "eyJ") || !strings.Contains(log.String(), "oidc:kc:u-1] Logged in.") {
		t.Errorf("log: %s", log)
	}
}
