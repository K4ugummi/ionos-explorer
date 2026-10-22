package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/K4ugummi/ionos-explorer/exporter/internal/server"
)

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

var loginURL = regexp.MustCompile(`http://127\.0\.0\.1:[0-9]+/login\?secret=[A-Za-z0-9_-]{43}`)

// serve runs the command until the returned stop is called.
func serve(t *testing.T, args []string, open func(string) error) (url string, stdout, stderr *syncBuffer, stop func() int) {
	t.Helper()
	stdout, stderr = &syncBuffer{}, &syncBuffer{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int, 1)
	go func() { done <- run(ctx, args, stdout, stderr, open) }()
	deadline := time.Now().Add(5 * time.Second)
	for url == "" && time.Now().Before(deadline) {
		select {
		case code := <-done:
			t.Fatalf("exit %d: %s", code, stderr)
		case <-time.After(5 * time.Millisecond):
		}
		url = loginURL.FindString(stdout.String())
	}
	if url == "" {
		t.Fatalf("no URL printed: %s", stdout)
	}
	var once sync.Once
	code := 0
	return url, stdout, stderr, func() int {
		once.Do(func() {
			cancel()
			code = <-done
		})
		return code
	}
}

func TestServesTheLoginLink(t *testing.T) {
	url, stdout, stderr, stop := serve(t, []string{"--open=false"}, func(string) error { t.Error("opened a browser"); return nil })
	defer stop()
	resp, err := http.Get(url) // follows nothing: the login page refreshes itself
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || !bytes.Contains(body, []byte("/#session=")) || len(resp.Cookies()) != 1 {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	req, _ := http.NewRequest("GET", strings.Split(url, "/login")[0]+"/", nil)
	req.AddCookie(resp.Cookies()[0])
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	page, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	// go test builds without the embedui tag: the placeholder page.
	if resp.StatusCode != 200 || !bytes.Contains(page, []byte("built without the user interface")) {
		t.Errorf("%d %s", resp.StatusCode, page)
	}
	if code := stop(); code != 0 {
		t.Errorf("exit %d", code)
	}
	if !strings.Contains(stdout.String(), "nothing is written to disk") || !strings.Contains(stderr.String(), "Built without the UI") ||
		!strings.Contains(stderr.String(), "Stopping") {
		t.Errorf("stdout %s\nstderr %s", stdout, stderr)
	}
}

func TestOpensTheBrowserWithoutTheSecretOnACommandLine(t *testing.T) {
	ch := make(chan string, 1)
	url, _, _, stop := serve(t, nil, func(target string) error { ch <- target; return nil })
	var opened string
	select {
	case opened = <-ch:
	case <-time.After(5 * time.Second):
	}
	if opened == "" || strings.Contains(opened, "secret") {
		t.Fatalf("opened %q", opened)
	}
	info, err := os.Stat(opened)
	dir, _ := os.Stat(filepath.Dir(opened))
	if err != nil || info.Mode().Perm() != 0o600 || dir.Mode().Perm() != 0o700 {
		t.Fatalf("%v %v %v", err, info, dir)
	}
	page, _ := os.ReadFile(opened)
	if !bytes.Contains(page, []byte(`http-equiv="refresh" content="0; url=`+url+`"`)) {
		t.Errorf("launcher %s", page)
	}
	stop()
	if _, err := os.Stat(filepath.Dir(opened)); !os.IsNotExist(err) {
		t.Error("the launcher file outlived the program")
	}
}

func TestRefusesWhatItShouldNot(t *testing.T) {
	for _, args := range [][]string{
		{"--listen", "0.0.0.0:0"},
		{"--listen", ":8080"},
		{"--listen", "192.168.0.1:8080"},
		{"--base-url", "ftp://x", "--open=false"},
		{"some-token-pasted-here"},
		{"--no-such-flag"},
	} {
		var stdout, stderr bytes.Buffer
		code := run(context.Background(), args, &stdout, &stderr, nil)
		if code != 1 || strings.Contains(stdout.String()+stderr.String(), "some-token-pasted-here") || loginURL.MatchString(stdout.String()) {
			t.Errorf("%v: exit %d\n%s%s", args, code, stdout.String(), stderr.String())
		}
		if args[0] == "--listen" && !strings.Contains(stderr.String(), "only loopback addresses") {
			t.Errorf("%v: %s", args, stderr.String())
		}
	}
	var stdout bytes.Buffer
	if code := run(context.Background(), []string{"--version"}, &stdout, io.Discard, nil); code != 0 || !strings.HasPrefix(stdout.String(), "ionos-explorer ") {
		t.Errorf("%d %s", code, stdout.String())
	}
}

func TestHostedNeedsItsConfiguration(t *testing.T) {
	for _, c := range []struct {
		args []string
		env  map[string]string
		want string
	}{
		{[]string{"--mode", "hosted"}, nil, "needs the public URL"},
		{[]string{"--mode", "hosted", "--public-url", "http://explorer.example.com"}, nil, "https is required"},
		{nil, map[string]string{"IONOS_EXPLORER_MODE": "hosted", "IONOS_EXPLORER_PUBLIC_URL": "https://explorer.example.com", "IONOS_EXPLORER_LOCAL_USERS": "false"}, "needs a login method"},
		{[]string{"--mode", "hosted", "--public-url", "https://explorer.example.com", "--data-dir", "/nonexistent/x"}, nil, "data directory /nonexistent/x: not found"},
		{[]string{"--data-dir", "/tmp"}, nil, "--data-dir is for --mode hosted"},
		{[]string{"--mode", "team"}, nil, `--mode "team": local or hosted`},
		{[]string{"--public-url", "https://explorer.example.com"}, nil, "--public-url is for --mode hosted"},
		{nil, map[string]string{"IONOS_EXPLORER_SESSION_TTL": "1h"}, "--session-ttl is for --mode hosted"},
		{nil, map[string]string{"IONOS_EXPLORER_MAX_FETCHES": "many"}, "IONOS_EXPLORER_MAX_FETCHES: "},
		{nil, map[string]string{"IONOS_EXPLORER_LISTEN": "0.0.0.0:8080"}, "only loopback addresses"},
		{[]string{"--age-identity-file", "/tmp/x"}, nil, "--age-identity-file is for --mode hosted"},
		{hostedTmp(t, "--age-identity-file", "/nonexistent/key"), nil, "age identity file: open /nonexistent/key"},
		{hostedTmp(t, "--age-identity-file", writeTemp(t, "AGE-SECRET-KEY-1NOTAKEY\n")), nil, "line 1: not an age X25519 identity"},
		{hostedTmp(t, "--keep", "yearly=3"), nil, "--keep: "},
		{hostedTmp(t, "--max-user-bytes", "lots"), nil, "--max-user-bytes: "},
		{hostedTmp(t, "--local-totp", "required"), nil, "--local-totp required needs --age-identity-file"},
		{hostedTmp(t, "--local-totp", "sometimes"), nil, `two-factor authentication "sometimes": off, optional or required`},
		{[]string{"--oidc-providers", "kc"}, nil, "--oidc-providers is for --mode hosted"},
		{hostedTmp(t, "--oidc-providers", "kc"), nil, "OIDC provider kc needs IONOS_EXPLORER_OIDC_KC_ISSUER, IONOS_EXPLORER_OIDC_KC_CLIENT_ID and IONOS_EXPLORER_OIDC_KC_CLIENT_SECRET"},
		{hostedTmp(t, "--oidc-providers", "kc,kc"), nil, "kc twice"},
		{hostedTmp(t, "--oidc-providers", "Key Cloak"), oidcEnv("KEY CLOAK"), `the ID may only hold`},
		{hostedTmp(t, "--oidc-providers", "kc"), map[string]string{"IONOS_EXPLORER_OIDC_KC_ISSUER": "http://idp.example", "IONOS_EXPLORER_OIDC_KC_CLIENT_ID": "c", "IONOS_EXPLORER_OIDC_KC_CLIENT_SECRET": "s"}, "https is required"},
		{hostedTmp(t, "--oidc-providers", "kc"), merge(oidcEnv("KC"), map[string]string{"IONOS_EXPLORER_OIDC_KC_ALLOWED_GROPS": "x"}), "IONOS_EXPLORER_OIDC_KC_ALLOWED_GROPS: not a setting of a provider in --oidc-providers"},
		{hostedTmp(t), oidcEnv("KC"), "IONOS_EXPLORER_OIDC_KC_CLIENT_ID, IONOS_EXPLORER_OIDC_KC_CLIENT_SECRET, IONOS_EXPLORER_OIDC_KC_ISSUER: not a setting"},
		{hostedTmp(t, "--oidc-providers", "kc"), merge(oidcEnv("KC"), map[string]string{"IONOS_EXPLORER_OIDC_KC_CLIENT_SECRET_FILE": "/nonexistent/secret"}), "IONOS_EXPLORER_OIDC_KC_CLIENT_SECRET and IONOS_EXPLORER_OIDC_KC_CLIENT_SECRET_FILE are both set"},
	} {
		t.Run(strings.Join(c.args, " "), func(t *testing.T) {
			for k, v := range c.env {
				t.Setenv(k, v)
			}
			var stdout, stderr bytes.Buffer
			if code := run(context.Background(), c.args, &stdout, &stderr, nil); code != 1 || !strings.Contains(stderr.String(), c.want) {
				t.Errorf("%v %v: exit %d, %s", c.args, c.env, code, stderr.String())
			}
			if strings.Contains(stderr.String(), "NOTAKEY") {
				t.Error("the key file's content is in the message")
			}
		})
	}
}

// oidcEnv sets up provider id (in capitals) in the environment.
func oidcEnv(id string) map[string]string {
	p := "IONOS_EXPLORER_OIDC_" + id + "_"
	return map[string]string{p + "ISSUER": "https://idp.example/realms/x", p + "CLIENT_ID": "explorer", p + "CLIENT_SECRET": "s3cret"}
}

func merge(a, b map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		out[k] = v
	}
	return out
}

func TestOIDCConfig(t *testing.T) {
	p := "IONOS_EXPLORER_OIDC_MY_IDP_"
	t.Setenv(p+"ISSUER", "https://idp.example/realms/x\n")
	t.Setenv(p+"CLIENT_ID", "explorer")
	t.Setenv(p+"CLIENT_SECRET_FILE", writeTemp(t, "s3cret\n"))
	t.Setenv(p+"NAME", "Company login")
	t.Setenv(p+"SCOPES", "openid profile, email groups")
	t.Setenv(p+"GROUPS_CLAIM", "realm_access.roles")
	t.Setenv(p+"ALLOWED_GROUPS", "Explorer Users, /ops/admins")
	t.Setenv(p+"ALLOWED_EMAILS", "@example.com boss@example.org")
	t.Setenv(p+"ADMIN_GROUPS", "/ops/admins")
	cfg, err := oidcConfig("my-idp")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ID != "my-idp" || cfg.Issuer != "https://idp.example/realms/x" || cfg.ClientSecret != "s3cret" || cfg.Name != "Company login" ||
		strings.Join(cfg.Scopes, "|") != "openid|profile|email|groups" || cfg.GroupsClaim != "realm_access.roles" ||
		strings.Join(cfg.AllowedGroups, "|") != "Explorer Users|/ops/admins" || strings.Join(cfg.AllowedEmails, "|") != "@example.com|boss@example.org" ||
		strings.Join(cfg.AdminGroups, "|") != "/ops/admins" {
		t.Errorf("%+v", cfg)
	}
}

// An identity provider that does not answer does not stop the start: its
// button is shown unavailable, and with no other way to log in the server
// is not ready.
func TestHostedOIDCProviderDown(t *testing.T) {
	for k, v := range oidcEnv("KC") {
		t.Setenv(k, v)
	}
	t.Setenv("IONOS_EXPLORER_OIDC_KC_ISSUER", "https://127.0.0.1:1/realms/x")
	t.Setenv("IONOS_EXPLORER_OIDC_KC_NAME", "Keycloak")
	stderr := &syncBuffer{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int, 1)
	go func() {
		done <- run(ctx, []string{"--mode", "hosted", "--public-url", "https://explorer.example.com", "--listen", "127.0.0.1:0", "--local-users=false", "--oidc-providers", "kc"},
			io.Discard, stderr, nil)
	}()
	listening := regexp.MustCompile(`listening on (127\.0\.0\.1:[0-9]+) for`)
	var addr string
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if m := listening.FindStringSubmatch(stderr.String()); m != nil && strings.Contains(stderr.String(), "Login provider kc: discovery at") {
			addr = m[1]
			break
		}
	}
	if addr == "" {
		t.Fatalf("stderr %s", stderr)
	}
	get := func(path string) (int, string) {
		req, _ := http.NewRequest("GET", "http://"+addr+path, nil)
		req.Host = "explorer.example.com"
		resp, err := http.DefaultTransport.RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}
	if code, body := get("/api/login-methods"); code != http.StatusOK || body != `{"app":"ionos-explorer","local":false,"providers":[{"label":"Keycloak","url":"/login/kc","unavailable":true}]}`+"\n" {
		t.Errorf("login methods: %d %s", code, body)
	}
	if code, body := get("/readyz"); code != http.StatusServiceUnavailable || body != "not ready: no login provider works\n" {
		t.Errorf("readyz: %d %s", code, body)
	}
	if code, body := get("/login/kc"); code != http.StatusServiceUnavailable || !strings.Contains(body, "Keycloak cannot be reached") {
		t.Errorf("login: %d %s", code, body)
	}
	cancel()
	if code := <-done; code != 0 || strings.Contains(stderr.String(), "s3cret") || !strings.Contains(stderr.String(), "everyone it lets log in") {
		t.Errorf("exit %d: %s", code, stderr)
	}
}

// hostedTmp is a hosted command line with a fresh data directory, plus args.
func hostedTmp(t *testing.T, args ...string) []string {
	return append([]string{"--mode", "hosted", "--public-url", "https://explorer.example.com", "--listen", "127.0.0.1:0", "--data-dir", t.TempDir()}, args...)
}

// writeTemp writes a temporary file and answers its path.
func writeTemp(t *testing.T, content string) string {
	path := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// fakeAuth logs in whoever /login?user=… names.
type fakeAuth struct{}

func (fakeAuth) Label() string    { return "Test login" }
func (fakeAuth) Routes() []string { return []string{"/login"} }

func (fakeAuth) ServeLogin(w http.ResponseWriter, r *http.Request, _ string, done server.LoginFunc) {
	done(w, r, server.Identity{Subject: "test:" + r.URL.Query().Get("user"), Name: r.URL.Query().Get("user")})
}

func TestHosted(t *testing.T) {
	newAuth = func(context.Context, string, string, *server.Logger) ([]server.Authenticator, error) {
		return []server.Authenticator{fakeAuth{}}, nil
	}
	t.Cleanup(func() { newAuth = oidcProviders })
	t.Setenv("IONOS_EXPLORER_PUBLIC_URL", "https://explorer.example.com/tools")
	t.Setenv("IONOS_EXPLORER_DATA_DIR", t.TempDir())
	stdout, stderr := &syncBuffer{}, &syncBuffer{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int, 1)
	go func() {
		done <- run(ctx, []string{"--mode", "hosted", "--listen", "127.0.0.1:0"}, stdout, stderr, func(string) error { t.Error("opened a browser"); return nil })
	}()
	listening := regexp.MustCompile(`listening on (127\.0\.0\.1:[0-9]+) for https://explorer\.example\.com/tools\.`)
	var addr string
	for deadline := time.Now().Add(5 * time.Second); addr == "" && time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if m := listening.FindStringSubmatch(stderr.String()); m != nil {
			addr = m[1]
		}
	}
	if addr == "" || strings.Contains(stdout.String()+stderr.String(), "secret") {
		t.Fatalf("stdout %s\nstderr %s", stdout, stderr)
	}
	get := func(path, host string) *http.Response {
		req, _ := http.NewRequest("GET", "http://"+addr+path, nil)
		req.Host = host
		resp, err := http.DefaultTransport.RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp
	}
	if resp := get("/tools/", addr); resp.StatusCode != http.StatusMisdirectedRequest {
		t.Errorf("own address as Host: %d", resp.StatusCode)
	}
	if resp := get("/tools/", "explorer.example.com"); resp.StatusCode != http.StatusOK {
		t.Errorf("page without login: %d %v", resp.StatusCode, resp.Header)
	}
	resp := get("/tools/login?user=alice", "explorer.example.com")
	if c := resp.Cookies(); resp.StatusCode != http.StatusSeeOther || len(c) != 1 || c[0].Name != "__Secure-ionos-explorer" {
		t.Errorf("login: %d %v", resp.StatusCode, c)
	}
	cancel()
	if code := <-done; code != 0 || !strings.Contains(stderr.String(), "Stopping") || !strings.Contains(stderr.String(), "test:alice] Logged in.") ||
		!strings.Contains(stderr.String(), "No snapshot history") {
		t.Errorf("exit %d: %s", code, stderr)
	}
}
