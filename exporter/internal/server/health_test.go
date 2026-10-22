package server

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/K4ugummi/ionos-explorer/exporter/internal/users"
)

// probe asks the server at its root, as Docker or Kubernetes would: by
// the container's address, without cookie or key.
func (h *harness) probe(method, path string) (int, string) {
	h.t.Helper()
	r, err := http.NewRequest(method, h.url+path, nil)
	if err != nil {
		h.t.Fatal(err)
	}
	r.Host = "10.1.2.3:8080"
	resp, err := http.DefaultTransport.RoundTrip(r)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.Header.Get("Cache-Control") != "no-store" || resp.Header.Get("X-Content-Type-Options") != "nosniff" {
		h.t.Errorf("%s headers: %v", path, resp.Header)
	}
	return resp.StatusCode, string(b)
}

func TestProbesLocal(t *testing.T) {
	h := start(t, nil)
	for _, path := range []string{"/healthz", "/readyz"} {
		if code, body := h.probe(http.MethodGet, path); code != http.StatusOK || body != "ok\n" {
			t.Errorf("%s: %d %q", path, code, body)
		}
		if code, _ := h.probe(http.MethodPost, path); code != http.StatusMethodNotAllowed {
			t.Errorf("POST %s: %d", path, code)
		}
	}
	// Any other path keeps the Host check.
	if code, _ := h.probe(http.MethodGet, "/api/status"); code != http.StatusMisdirectedRequest {
		t.Errorf("/api/status by address: %d", code)
	}

	h.s.Close()
	if code, _ := h.probe(http.MethodGet, "/healthz"); code != http.StatusOK {
		t.Errorf("healthz while shutting down: %d", code)
	}
	for range 2 {
		if code, body := h.probe(http.MethodGet, "/readyz"); code != http.StatusServiceUnavailable || body != "not ready: shutting down\n" {
			t.Errorf("readyz while shutting down: %d %q", code, body)
		}
	}
	if n := strings.Count(h.log.String(), "Not ready: shutting down."); n != 1 {
		t.Errorf("logged %d times:\n%s", n, h.log)
	}
}

type unready struct{ fakeAuth }

var errIdP = errors.New("discovery: connection refused")

func (unready) Ready() error { return errIdP }

func TestProbesHosted(t *testing.T) {
	// At the root, also under a base path; the base path itself has none.
	h := startHosted(t, "https://tools.example.com/ionos-explorer", nil)
	if code, body := h.probe(http.MethodGet, "/readyz"); code != http.StatusOK || body != "ok\n" {
		t.Errorf("readyz: %d %q", code, body)
	}
	if code, _ := h.probe(http.MethodGet, "/healthz"); code != http.StatusOK {
		t.Errorf("healthz: %d", code)
	}

	h = startHosted(t, "https://explorer.example.com", func(o *Options) { o.Hosted.Auth = []Authenticator{unready{}} })
	if code, body := h.probe(http.MethodGet, "/readyz"); code != http.StatusServiceUnavailable || body != "not ready: no login provider works\n" {
		t.Errorf("readyz with a broken provider: %d %q", code, body)
	}
	if !strings.Contains(h.log.String(), "Not ready: no login provider works: Test login: "+errIdP.Error()) {
		t.Error(h.log.String())
	}

	// One provider that works is enough; so are local users.
	h = startHosted(t, "https://explorer.example.com", func(o *Options) { o.Hosted.Auth = []Authenticator{unready{}, other{}} })
	if code, body := h.probe(http.MethodGet, "/readyz"); code != http.StatusOK {
		t.Errorf("readyz with one of two providers: %d %q", code, body)
	}
	l, _ := startLocal(t, nil, func(o *Options, _ *users.Store) { o.Hosted.Auth = []Authenticator{unready{}} })
	if code, body := l.probe(http.MethodGet, "/readyz"); code != http.StatusOK {
		t.Errorf("readyz with local users and a broken provider: %d %q", code, body)
	}
}

func TestProbesUserStore(t *testing.T) {
	h, store := startLocal(t, nil, nil)
	dir := filepath.Dir(store.Path())
	ready := func(want int) string {
		t.Helper()
		code, body := h.probe(http.MethodGet, "/readyz")
		if code != want {
			t.Errorf("readyz: %d %q, want %d", code, body, want)
		}
		if strings.Contains(body, dir) {
			t.Errorf("readyz shows the path: %q", body)
		}
		return body
	}
	ready(http.StatusOK)

	// A file that does not parse: logins would fail.
	if err := os.WriteFile(store.Path(), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if body := ready(http.StatusServiceUnavailable); body != "not ready: the user accounts cannot be read or written\n" {
		t.Errorf("broken file: %q", body)
	}
	if err := os.Remove(store.Path()); err != nil {
		t.Fatal(err)
	}
	ready(http.StatusOK)

	// A directory that takes no files (a volume mounted read-only).
	if os.Geteuid() != 0 { // root writes anyway
		if err := os.Chmod(dir, 0o500); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.Chmod(dir, 0o700) })
		ready(http.StatusServiceUnavailable)
		os.Chmod(dir, 0o700)
		ready(http.StatusOK)
	}
	log := h.log.String()
	if !strings.Contains(log, "Not ready: the user accounts cannot be read or written: "+store.Path()) || !strings.Contains(log, "Ready again.") {
		t.Error(log)
	}
	if entries, _ := os.ReadDir(dir); len(entries) > 1 {
		t.Errorf("left behind: %v", entries)
	}
}

func TestJSONLog(t *testing.T) {
	h, store := startLocal(t, nil, func(o *Options, _ *users.Store) { o.LogJSON = true })
	addUser(t, store, "alice", users.RoleUser, false)
	a := h.client()
	a.passwordLogin("alice", password)
	a.post("/api/logout", "{}")
	h.probe(http.MethodGet, "/readyz") // ok: nothing logged
	h.s.Close()
	h.probe(http.MethodGet, "/readyz")

	var setup, login, logout, unready bool
	sc := bufio.NewScanner(strings.NewReader(h.log.String()))
	for sc.Scan() {
		var line map[string]string
		if err := json.Unmarshal(sc.Bytes(), &line); err != nil {
			t.Fatalf("not a JSON object: %q", sc.Text())
		}
		if line["time"] == "" || line["level"] == "" || line["msg"] == "" {
			t.Errorf("fields: %v", line)
		}
		switch {
		case strings.HasPrefix(line["msg"], "No user accounts yet"):
			setup = strings.HasPrefix(line["link"], "https://explorer.example/#setup=")
		case line["msg"] == "Logged in.":
			login = len(line["session"]) == 8 && strings.HasPrefix(line["user"], "local:u")
		case line["msg"] == "Logged out.":
			logout = line["session"] != ""
		case line["msg"] == "Not ready: shutting down.":
			unready = line["level"] == "ERROR"
		}
	}
	if !setup || !login || !logout || !unready {
		t.Errorf("setup %v, login %v, logout %v, not ready %v:\n%s", setup, login, logout, unready, h.log)
	}
	for _, secret := range []string{a.key, a.cookie.Value, password} {
		if strings.Contains(h.log.String(), secret) {
			t.Errorf("secret in the log:\n%s", h.log)
		}
	}
}
