// Package oidc logs users of hosted mode in at OpenID Connect identity
// providers (Keycloak, Entra ID, Google, Authentik, Dex, …): the
// authorization code flow with PKCE for a confidential client, the ID token
// verified with go-oidc, and allow lists by group and email. Each Provider
// is one identity provider and one button on the login screen
// (server.Authenticator). See docs/ARCHITECTURE.md, "OIDC providers".
package oidc

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"

	"github.com/K4ugummi/ionos-explorer/exporter/internal/server"
)

// Config is one identity provider.
type Config struct {
	// ID names it in its routes (/login/<id>, /callback/<id>), in the
	// subjects of its users (oidc:<id>:<sub>) and in the environment:
	// [a-z0-9-]{1,32}.
	ID string
	// Name is the label of its button (default: the ID).
	Name string
	// Issuer is its issuer URL; the discovery document is below it, at
	// /.well-known/openid-configuration.
	Issuer string
	// ClientID and ClientSecret are the explorer's client there, with the
	// redirect URI PUBLIC_URL/callback/<id>.
	ClientID, ClientSecret string
	// Scopes asked for (default openid profile email; openid is always
	// added).
	Scopes []string
	// GroupsClaim is the claim of the ID token with the user's groups or
	// roles (default groups); a.b looks into nested objects (Keycloak's
	// realm_access.roles) unless a claim has that very name.
	GroupsClaim string
	// Who may log in: members of one of AllowedGroups, or users whose
	// verified email is in AllowedEmails (an address, or @domain for all of
	// a domain). Both empty: everyone the provider lets log in to the
	// client. Members of AdminGroups are admins, and may log in too.
	AllowedGroups, AllowedEmails, AdminGroups []string
}

// Options are what every provider of a server shares.
type Options struct {
	// PublicURL is hosted mode's public URL (server.Hosted.PublicURL).
	PublicURL string
	// Client makes the requests to the identity provider (default: 15 s
	// timeout, proxy from HTTPS_PROXY/NO_PROXY).
	Client *http.Client
	Log    *server.Logger

	now func() time.Time // the clock of the token checks (tests)
}

var (
	idPattern = regexp.MustCompile(`^[a-z0-9-]{1,32}$`)
	// Asymmetric algorithms only: never none, never HS* (that would make
	// the client secret a signing key).
	signingAlgs = []string{oidc.RS256, oidc.RS384, oidc.RS512, oidc.ES256, oidc.ES384, oidc.ES512, oidc.PS256, oidc.PS384, oidc.PS512, oidc.EdDSA}
)

const (
	// attemptTTL is how long a login may take at the identity provider.
	attemptTTL = 10 * time.Minute
	// skew is the clock difference to the identity provider allowed for exp
	// and iat.
	skew = 2 * time.Minute
	// retryAfter keeps a login from asking a provider that did not answer
	// more often than this.
	retryAfter = 10 * time.Second
	// maxErrorText limits what an identity provider's error may put in the
	// page.
	maxErrorText = 200
)

// Provider is one identity provider: a server.Authenticator, a
// server.Readier and a server.Logouter.
type Provider struct {
	cfg      Config
	label    string
	redirect string // PUBLIC_URL/callback/<id>
	home     string // PUBLIC_URL/
	cookie   http.Cookie
	aead     cipher.AEAD // seals the login attempt in its cookie
	client   *http.Client
	log      *server.Logger
	now      func() time.Time

	fetch   sync.Mutex // one discovery at a time
	mu      sync.Mutex
	disc    *discovered // nil until the discovery answered
	lastErr error
	lastTry time.Time
	// The state of every login that went through, until its attempt would
	// have expired: the same answer is not taken twice.
	used map[string]time.Time
}

// discovered is what the discovery document says.
type discovered struct {
	verifier   *oidc.IDTokenVerifier
	oauth      oauth2.Config
	endSession string
}

// New checks a provider's configuration. Its discovery is fetched by Start
// or the first login.
func New(cfg Config, opts Options) (*Provider, error) {
	if !idPattern.MatchString(cfg.ID) {
		return nil, fmt.Errorf("OIDC provider %q: the ID may only hold a-z, 0-9 and -, at most 32", cfg.ID)
	}
	fail := func(format string, a ...any) error {
		return fmt.Errorf("OIDC provider %s: "+format, append([]any{cfg.ID}, a...)...)
	}
	pub, err := server.ParsePublicURL(opts.PublicURL)
	if err != nil {
		return nil, err
	}
	home, _ := url.Parse(pub.String() + "/")
	iss, err := url.Parse(cfg.Issuer)
	switch {
	case cfg.Issuer == "":
		return nil, fail("the issuer URL is missing")
	case err != nil || iss.Host == "" || iss.User != nil || iss.RawQuery != "" || iss.Fragment != "":
		return nil, fail("issuer %q: not an absolute URL without query", cfg.Issuer)
	case iss.Scheme == "http" && home.Scheme == "http":
		// A trial on localhost, with a test identity provider.
	case iss.Scheme != "https":
		return nil, fail("issuer %q: https is required", cfg.Issuer)
	}
	if cfg.ClientID == "" || cfg.ClientSecret == "" {
		return nil, fail("the client ID and the client secret are needed")
	}
	if len(cfg.Scopes) == 0 {
		cfg.Scopes = []string{oidc.ScopeOpenID, "profile", "email"}
	} else if !slices.Contains(cfg.Scopes, oidc.ScopeOpenID) {
		cfg.Scopes = append([]string{oidc.ScopeOpenID}, cfg.Scopes...)
	}
	if cfg.GroupsClaim == "" {
		cfg.GroupsClaim = "groups"
	}
	cfg.AllowedEmails = slices.Clone(cfg.AllowedEmails)
	for i, e := range cfg.AllowedEmails {
		e = strings.ToLower(e)
		at := strings.LastIndex(e, "@")
		if at < 0 || at == len(e)-1 || strings.ContainsAny(e, " ,") {
			return nil, fail("allowed email %q: an address or @domain", e)
		}
		cfg.AllowedEmails[i] = e
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	block, _ := aes.NewCipher(key)
	aead, _ := cipher.NewGCM(block)
	p := &Provider{cfg: cfg, label: cfg.Name, redirect: pub.String() + "/callback/" + cfg.ID, home: home.String(), aead: aead,
		client: opts.Client, log: opts.Log, now: opts.now, used: map[string]time.Time{}}
	if p.label == "" {
		p.label = cfg.ID
	}
	if p.client == nil {
		p.client = &http.Client{Timeout: 15 * time.Second}
	}
	if p.log == nil {
		p.log = server.NewLogger(nil, false)
	}
	if p.now == nil {
		p.now = time.Now
	}
	// Sent back only to its own callback (so not to another provider's),
	// and Lax: the identity provider's redirect back is a cross-site
	// navigation.
	p.cookie = http.Cookie{Name: "ionos-explorer-login-" + cfg.ID, Path: home.Path + "callback/" + cfg.ID, HttpOnly: true, SameSite: http.SameSiteLaxMode}
	if home.Scheme == "https" {
		p.cookie.Name, p.cookie.Secure = "__Secure-"+p.cookie.Name, true
	}
	return p, nil
}

// ID is the provider's ID.
func (p *Provider) ID() string { return p.cfg.ID }

// Label is the text of its button.
func (p *Provider) Label() string { return p.label }

// Routes are /login/<id>, which the button opens, and /callback/<id>, where
// the identity provider sends the browser back.
func (p *Provider) Routes() []string { return []string{"/login/" + p.cfg.ID, "/callback/" + p.cfg.ID} }

// Start fetches the discovery document in the background, again and again
// until it answers or ctx ends, so the button works when the first user
// comes and /readyz knows.
func (p *Provider) Start(ctx context.Context) {
	if len(p.cfg.AllowedGroups) == 0 && len(p.cfg.AllowedEmails) == 0 {
		p.log.Print(fmt.Sprintf("Login provider %s: everyone it lets log in to client %s may use the explorer (no allowed groups or emails).", p.cfg.ID, printable(p.cfg.ClientID)))
	}
	go func() {
		wait := 5 * time.Second
		var last string
		for {
			_, err := p.discovery(ctx, true)
			if err == nil {
				p.log.Print(fmt.Sprintf("Login provider %s ready (%s).", p.cfg.ID, p.cfg.Issuer))
				return
			}
			if msg := err.Error(); msg != last {
				p.log.Error(fmt.Sprintf("Login provider %s: %v; trying again.", p.cfg.ID, err))
				last = msg
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
			wait = min(2*wait, 2*time.Minute)
		}
	}()
}

// Ready says whether the discovery document has been fetched. It does not
// block.
func (p *Provider) Ready() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	switch {
	case p.disc != nil:
		return nil
	case p.lastErr != nil:
		return p.lastErr
	default:
		return errors.New("not reached yet")
	}
}

// discovery returns what the discovery document says, fetching it if it
// has not answered yet (unless it was asked less than retryAfter ago, or
// always with force).
func (p *Provider) discovery(ctx context.Context, force bool) (*discovered, error) {
	p.fetch.Lock()
	defer p.fetch.Unlock()
	p.mu.Lock()
	d, last, lastErr := p.disc, p.lastTry, p.lastErr
	p.mu.Unlock()
	if d != nil {
		return d, nil
	}
	if !force && lastErr != nil && time.Since(last) < retryAfter {
		return nil, lastErr
	}
	d, err := p.discover(ctx)
	p.mu.Lock()
	defer p.mu.Unlock()
	p.disc, p.lastErr, p.lastTry = d, err, time.Now()
	return d, err
}

func (p *Provider) discover(ctx context.Context) (*discovered, error) {
	// Not cut short by the request that asked: the answer is for everyone.
	ctx, cancel := context.WithTimeout(oidc.ClientContext(context.WithoutCancel(ctx), p.client), 15*time.Second)
	defer cancel()
	op, err := oidc.NewProvider(ctx, p.cfg.Issuer)
	if err != nil {
		return nil, fmt.Errorf("discovery at %s: %w", p.cfg.Issuer, err)
	}
	var meta struct {
		Algs       []string `json:"id_token_signing_alg_values_supported"`
		EndSession string   `json:"end_session_endpoint"`
	}
	if err := op.Claims(&meta); err != nil {
		return nil, fmt.Errorf("discovery at %s: %w", p.cfg.Issuer, err)
	}
	algs := signingAlgs
	if len(meta.Algs) > 0 {
		algs = nil
		for _, a := range meta.Algs {
			if slices.Contains(signingAlgs, a) {
				algs = append(algs, a)
			}
		}
		if len(algs) == 0 {
			return nil, fmt.Errorf("it signs ID tokens only with %s, none of %s", strings.Join(meta.Algs, ", "), strings.Join(signingAlgs, ", "))
		}
	}
	if u, err := url.Parse(meta.EndSession); err != nil || u.Scheme != "https" && u.Scheme != "http" {
		meta.EndSession = ""
	}
	keys := oidc.ClientContext(context.Background(), p.client) // refreshes the keys when a token names a new one
	return &discovered{
		verifier: op.VerifierContext(keys, &oidc.Config{ClientID: p.cfg.ClientID, SupportedSigningAlgs: algs,
			// exp with the allowed skew; iat is checked in callback.
			Now: func() time.Time { return p.now().Add(-skew) }}),
		oauth:      oauth2.Config{ClientID: p.cfg.ClientID, ClientSecret: p.cfg.ClientSecret, Endpoint: op.Endpoint(), RedirectURL: p.redirect, Scopes: p.cfg.Scopes},
		endSession: meta.EndSession,
	}, nil
}

// ServeLogin answers its two routes.
func (p *Provider) ServeLogin(w http.ResponseWriter, r *http.Request, path string, done server.LoginFunc) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if path == "/login/"+p.cfg.ID {
		p.start(w, r)
	} else {
		p.callback(w, r, done)
	}
}

// attempt is one login under way, sealed in its cookie: nothing about it
// is kept in the server.
type attempt struct {
	Provider string    `json:"p"`
	State    string    `json:"s"`
	Nonce    string    `json:"n"`
	Verifier string    `json:"v"`
	Expires  time.Time `json:"e"`
}

// start sends the browser to the identity provider.
func (p *Provider) start(w http.ResponseWriter, r *http.Request) {
	d, err := p.discovery(r.Context(), false)
	if err != nil {
		p.page(w, http.StatusServiceUnavailable, p.label+" cannot be reached",
			"The explorer cannot reach this login provider right now. Try again in a minute, or log in another way.", link{p.home, "Back to the login page"})
		return
	}
	a := attempt{Provider: p.cfg.ID, State: random(), Nonce: random(), Verifier: oauth2.GenerateVerifier(), Expires: p.now().Add(attemptTTL)}
	c := p.cookie
	c.Value, c.MaxAge = p.seal(a), int(attemptTTL/time.Second)
	http.SetCookie(w, &c)
	http.Redirect(w, r, d.oauth.AuthCodeURL(a.State, oauth2.S256ChallengeOption(a.Verifier), oidc.Nonce(a.Nonce)), http.StatusFound)
}

// callback finishes a login: the identity provider sent the browser back
// with a code (or an error).
func (p *Provider) callback(w http.ResponseWriter, r *http.Request, done server.LoginFunc) {
	gone := p.cookie
	gone.MaxAge = -1
	http.SetCookie(w, &gone)
	again := link{p.home, "Back to the login page"}
	q := r.URL.Query()
	if e := q.Get("error"); e != "" {
		text := clip(e)
		if d := q.Get("error_description"); d != "" {
			text += ": " + clip(d)
		}
		p.log.Print(fmt.Sprintf("Login at %s did not complete: %s", p.cfg.ID, printable(text)))
		p.page(w, http.StatusBadRequest, "Login at "+p.label+" did not complete", p.label+" answered: "+text, again)
		return
	}
	var a attempt
	c, err := r.Cookie(p.cookie.Name)
	if err == nil {
		a, err = p.open(c.Value)
	}
	if err != nil || a.Provider != p.cfg.ID || !p.now().Before(a.Expires) || !same(q.Get("state"), a.State) || p.isUsed(a.State) {
		p.page(w, http.StatusBadRequest, "This login has expired", "It took too long, was started in another browser or tab, or was used already. Start again.", again)
		return
	}
	d, err := p.discovery(r.Context(), false)
	if err != nil {
		p.page(w, http.StatusServiceUnavailable, p.label+" cannot be reached", "Try again in a minute.", again)
		return
	}
	// RFC 9207: an answer that names an issuer must name this one.
	if iss := q.Get("iss"); iss != "" && iss != p.cfg.Issuer {
		p.failed(w, fmt.Errorf("the answer names issuer %q", iss))
		return
	}
	ctx, cancel := context.WithTimeout(oidc.ClientContext(r.Context(), p.client), 15*time.Second)
	defer cancel()
	tok, err := d.oauth.Exchange(ctx, q.Get("code"), oauth2.VerifierOption(a.Verifier))
	if err != nil {
		p.failed(w, fmt.Errorf("exchanging the code: %w", err))
		return
	}
	raw, _ := tok.Extra("id_token").(string)
	if raw == "" {
		p.failed(w, errors.New("no ID token in its answer (is openid among the scopes?)"))
		return
	}
	idt, err := d.verifier.Verify(ctx, raw)
	if err != nil {
		p.failed(w, err)
		return
	}
	var cl claims
	if err := idt.Claims(&cl.all); err != nil {
		p.failed(w, err)
		return
	}
	if err := p.check(idt, &cl, a.Nonce); err != nil {
		p.failed(w, err)
		return
	}
	p.markUsed(a.State, a.Expires)
	id := server.Identity{Subject: "oidc:" + p.cfg.ID + ":" + idt.Subject, Name: cl.name(idt.Subject), LogoutHint: raw}
	groups, overage := cl.groups(p.cfg.GroupsClaim)
	allowed, admin := p.allowed(cl.email(), groups)
	if !allowed {
		why := "not in an allowed group and no allowed verified email"
		if overage {
			why += "; the token lists no groups because the user has too many (Entra ID: use app roles, GROUPS_CLAIM=roles)"
		}
		p.log.Print(fmt.Sprintf("Login refused for %s (%s): %s.", printable(id.Subject), printable(id.Name), why))
		links := []link{again}
		if u := p.LogoutURL(id, p.home); u != "" {
			links = []link{{u, "Log out at " + p.label}, again}
		}
		p.page(w, http.StatusForbidden, "Not allowed",
			"You are logged in at "+p.label+" as "+id.Name+", but this account may not use this explorer. Ask whoever runs it to add you.", links...)
		return
	}
	id.Admin = admin
	done(w, r, id)
}

// check is what go-oidc leaves to its caller: the nonce, the authorized
// party with several audiences, iat, a subject.
func (p *Provider) check(idt *oidc.IDToken, cl *claims, nonce string) error {
	switch {
	case !same(idt.Nonce, nonce):
		return errors.New("the ID token is not for this login (nonce)")
	case idt.Subject == "":
		return errors.New("the ID token has no subject")
	case idt.IssuedAt.IsZero() || idt.IssuedAt.After(p.now().Add(skew)):
		return errors.New("the ID token was issued in the future (check the clocks)")
	}
	azp, _ := cl.all["azp"].(string)
	if azp != "" && azp != p.cfg.ClientID || azp == "" && len(idt.Audience) > 1 {
		return fmt.Errorf("the ID token was issued to %q (azp), not to this client", azp)
	}
	return nil
}

// allowed applies the allow lists; admins are always allowed.
func (p *Provider) allowed(email string, groups []string) (allowed, admin bool) {
	for _, g := range groups {
		admin = admin || slices.Contains(p.cfg.AdminGroups, g)
		allowed = allowed || slices.Contains(p.cfg.AllowedGroups, g)
	}
	switch {
	case admin || allowed:
		return true, admin
	case len(p.cfg.AllowedGroups) == 0 && len(p.cfg.AllowedEmails) == 0:
		return true, false
	case email == "":
		return false, false
	}
	for _, a := range p.cfg.AllowedEmails {
		if a == email || strings.HasPrefix(a, "@") && strings.HasSuffix(email, a) {
			return true, false
		}
	}
	return false, false
}

// failed answers a login the explorer refused to take, with the reason in
// the log only.
func (p *Provider) failed(w http.ResponseWriter, err error) {
	p.log.Error(fmt.Sprintf("Login at %s failed: %s", p.cfg.ID, printable(err.Error())))
	p.page(w, http.StatusBadGateway, "Login at "+p.label+" failed",
		"The explorer could not check the answer of "+p.label+". The server's log says why. Try again, or tell whoever runs the explorer.", link{p.home, "Back to the login page"})
}

// LogoutURL is the provider's end_session_endpoint (RP-initiated logout),
// which sends the browser back to back; "" if it has none.
func (p *Provider) LogoutURL(id server.Identity, back string) string {
	p.mu.Lock()
	d := p.disc
	p.mu.Unlock()
	if d == nil || d.endSession == "" {
		return ""
	}
	u, _ := url.Parse(d.endSession)
	q := u.Query()
	if id.LogoutHint != "" {
		q.Set("id_token_hint", id.LogoutHint)
	}
	q.Set("client_id", p.cfg.ClientID)
	q.Set("post_logout_redirect_uri", back)
	u.RawQuery = q.Encode()
	return u.String()
}

func (p *Provider) seal(a attempt) string {
	b, _ := json.Marshal(a)
	nonce := make([]byte, p.aead.NonceSize(), p.aead.NonceSize()+len(b)+p.aead.Overhead())
	if _, err := rand.Read(nonce); err != nil {
		panic(err) // crypto/rand does not fail on supported systems
	}
	return base64.RawURLEncoding.EncodeToString(p.aead.Seal(nonce, nonce, b, []byte(p.cfg.ID)))
}

func (p *Provider) open(v string) (attempt, error) {
	var a attempt
	b, err := base64.RawURLEncoding.DecodeString(v)
	if err != nil || len(b) < p.aead.NonceSize() {
		return a, errors.New("malformed")
	}
	n := p.aead.NonceSize()
	plain, err := p.aead.Open(nil, b[:n], b[n:], []byte(p.cfg.ID))
	if err != nil {
		return a, err
	}
	return a, json.Unmarshal(plain, &a)
}

func (p *Provider) isUsed(state string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	_, ok := p.used[state]
	return ok
}

func (p *Provider) markUsed(state string, until time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	for s, t := range p.used {
		if !now.Before(t) {
			delete(p.used, s)
		}
	}
	p.used[state] = until
}

// claims are the ID token's claims.
type claims struct{ all map[string]any }

func (c *claims) str(name string) string {
	v, _ := c.all[name].(string)
	return strings.TrimSpace(v)
}

// name is what the page shows: name, preferred_username, email or sub.
func (c *claims) name(sub string) string {
	for _, n := range []string{"name", "preferred_username", "email"} {
		if v := c.str(n); v != "" {
			return v
		}
	}
	return sub
}

// email is the user's email if the provider verified it, lower case.
func (c *claims) email() string {
	verified := false
	switch v := c.all["email_verified"].(type) {
	case bool:
		verified = v
	case string:
		verified = v == "true"
	}
	if !verified {
		return ""
	}
	return strings.ToLower(c.str("email"))
}

// groups reads the groups claim: a list of strings or one string. overage:
// the claim is missing because the token would be too large (Entra ID's
// _claim_names).
func (c *claims) groups(claim string) (groups []string, overage bool) {
	v, ok := c.all[claim]
	if !ok && strings.Contains(claim, ".") {
		var cur any = c.all
		for _, part := range strings.Split(claim, ".") {
			m, _ := cur.(map[string]any)
			cur = m[part]
		}
		v = cur
	}
	switch v := v.(type) {
	case string:
		return []string{v}, false
	case []any:
		for _, g := range v {
			if s, ok := g.(string); ok {
				groups = append(groups, s)
			}
		}
		return groups, false
	}
	names, _ := c.all["_claim_names"].(map[string]any)
	_, overage = names[claim]
	return nil, overage
}

type link struct{ URL, Text string }

// pageTemplate is the explorer's own page for a login that did not go
// through; everything in it escaped.
var pageTemplate = template.Must(template.New("page").Parse(`<!doctype html><html lang="en"><head><meta charset="utf-8">` +
	`<link rel="icon" href="data:,"><meta name="color-scheme" content="light dark"><title>IONOS Explorer</title></head>` +
	`<body style="font-family: system-ui, sans-serif; max-width: 40em; margin: 4em auto; padding: 0 1em"><h1>{{.Title}}</h1><p>{{.Text}}</p>` +
	`{{range .Links}}<p><a href="{{.URL}}">{{.Text}}</a></p>{{end}}</body></html>`))

func (p *Provider) page(w http.ResponseWriter, status int, title, text string, links ...link) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_ = pageTemplate.Execute(w, struct {
		Title, Text string
		Links       []link
	}{title, text, links})
}

func random() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand does not fail on supported systems
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func same(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }

// printable keeps what an identity provider or a user name holds from
// breaking a log line.
func printable(v string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, v)
}

// clip makes an identity provider's error text printable and short.
func clip(v string) string {
	v = printable(strings.Join(strings.Fields(v), " "))
	if r := []rune(v); len(r) > maxErrorText {
		v = string(r[:maxErrorText]) + "…"
	}
	return v
}
