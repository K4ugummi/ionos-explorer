package oidc

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
)

// fakeIdP is an OpenID Connect provider in the test: discovery, JWKS, an
// authorization endpoint that logs in User at once, and a token endpoint
// that checks the client, the redirect URI, PKCE and single use.
type fakeIdP struct {
	t   *testing.T
	srv *httptest.Server

	mu     sync.Mutex
	key    *ecdsa.PrivateKey
	kid    string
	old    []jose.JSONWebKey // keys still in the JWKS after a rotation
	codes  map[string]grant
	issuer string // the iss it writes (default: its URL)
	// User are the claims of whoever logs in next (sub and more).
	User map[string]any
	// Tamper changes the claims of the next ID token, Sign replaces the
	// signing (both once).
	Tamper func(map[string]any)
	Sign   func(claims []byte) string
	// Algs are the signing algorithms its discovery offers.
	Algs []string
	// tokens counts calls of the token endpoint.
	tokens int
}

type grant struct {
	clientID, redirect, nonce, challenge string
	user                                 map[string]any
}

const (
	clientID     = "explorer"
	clientSecret = "s3cret"
)

func newFakeIdP(t *testing.T) *fakeIdP {
	f := &fakeIdP{t: t, codes: map[string]grant{}, User: map[string]any{"sub": "u-1", "name": "Alice", "email": "alice@example.com", "email_verified": true}, Algs: []string{"ES256"}}
	f.rotate()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/openid-configuration", f.discovery)
	mux.HandleFunc("GET /jwks", f.jwks)
	mux.HandleFunc("GET /authorize", f.authorize)
	mux.HandleFunc("POST /token", f.token)
	f.srv = httptest.NewTLSServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeIdP) URL() string { return f.srv.URL }

// rotate makes a new signing key; the old one stays in the JWKS.
func (f *fakeIdP) rotate() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.key != nil {
		f.old = append(f.old, jose.JSONWebKey{Key: f.key.Public(), KeyID: f.kid, Algorithm: "ES256", Use: "sig"})
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		f.t.Fatal(err)
	}
	f.key, f.kid = key, fmt.Sprintf("k%d", len(f.old)+1)
}

func (f *fakeIdP) discovery(w http.ResponseWriter, _ *http.Request) {
	f.mu.Lock()
	algs := f.Algs
	f.mu.Unlock()
	_ = json.NewEncoder(w).Encode(map[string]any{
		"issuer": f.srv.URL, "authorization_endpoint": f.srv.URL + "/authorize", "token_endpoint": f.srv.URL + "/token",
		"jwks_uri": f.srv.URL + "/jwks", "end_session_endpoint": f.srv.URL + "/logout", "id_token_signing_alg_values_supported": algs,
		"code_challenge_methods_supported": []string{"S256"},
	})
}

func (f *fakeIdP) jwks(w http.ResponseWriter, _ *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	keys := append([]jose.JSONWebKey{{Key: f.key.Public(), KeyID: f.kid, Algorithm: "ES256", Use: "sig"}}, f.old...)
	_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: keys})
}

func (f *fakeIdP) authorize(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if q.Get("response_type") != "code" || q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" || q.Get("nonce") == "" ||
		!strings.Contains(" "+q.Get("scope")+" ", " openid ") {
		http.Error(w, "bad authorization request: "+r.URL.RawQuery, http.StatusBadRequest)
		return
	}
	code := random()
	f.mu.Lock()
	user := map[string]any{}
	for k, v := range f.User {
		user[k] = v
	}
	f.codes[code] = grant{clientID: q.Get("client_id"), redirect: q.Get("redirect_uri"), nonce: q.Get("nonce"), challenge: q.Get("code_challenge"), user: user}
	f.mu.Unlock()
	back, _ := url.Parse(q.Get("redirect_uri"))
	bq := back.Query()
	bq.Set("code", code)
	bq.Set("state", q.Get("state"))
	back.RawQuery = bq.Encode()
	http.Redirect(w, r, back.String(), http.StatusFound)
}

func (f *fakeIdP) token(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tokens++
	fail := func(e string) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": e})
	}
	if err := r.ParseForm(); err != nil {
		fail("invalid_request")
		return
	}
	id, secret, ok := r.BasicAuth()
	if !ok {
		id, secret = r.PostForm.Get("client_id"), r.PostForm.Get("client_secret")
	}
	if id != clientID || secret != clientSecret {
		fail("invalid_client")
		return
	}
	code := r.PostForm.Get("code")
	g, ok := f.codes[code]
	delete(f.codes, code) // single use
	sum := sha256.Sum256([]byte(r.PostForm.Get("code_verifier")))
	switch {
	case !ok || r.PostForm.Get("grant_type") != "authorization_code" || g.clientID != id:
		fail("invalid_grant")
		return
	case g.redirect != r.PostForm.Get("redirect_uri"):
		fail("invalid_grant")
		return
	case base64.RawURLEncoding.EncodeToString(sum[:]) != g.challenge:
		fail("invalid_grant") // PKCE
		return
	}
	now := time.Now()
	claims := map[string]any{"iss": f.srv.URL, "aud": clientID, "exp": now.Add(5 * time.Minute).Unix(), "iat": now.Unix(), "nonce": g.nonce}
	if f.issuer != "" {
		claims["iss"] = f.issuer
	}
	for k, v := range g.user {
		claims[k] = v
	}
	if f.Tamper != nil {
		f.Tamper(claims)
		f.Tamper = nil
	}
	payload, _ := json.Marshal(claims)
	var raw string
	if f.Sign != nil {
		raw = f.Sign(payload)
		f.Sign = nil
	} else {
		raw = f.signWith(f.key, f.kid, payload)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "at", "token_type": "Bearer", "expires_in": 300, "id_token": raw})
}

func (f *fakeIdP) signWith(key *ecdsa.PrivateKey, kid string, payload []byte) string {
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: key}, (&jose.SignerOptions{}).WithType("JWT").WithHeader("kid", kid))
	if err != nil {
		f.t.Fatal(err)
	}
	jws, err := signer.Sign(payload)
	if err != nil {
		f.t.Fatal(err)
	}
	raw, err := jws.CompactSerialize()
	if err != nil {
		f.t.Fatal(err)
	}
	return raw
}
