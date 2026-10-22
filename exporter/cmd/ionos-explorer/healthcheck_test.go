package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestProbeURL(t *testing.T) {
	for listen, want := range map[string]string{
		":8080":          "http://127.0.0.1:8080/healthz",
		"0.0.0.0:9000":   "http://127.0.0.1:9000/healthz",
		"[::]:8080":      "http://127.0.0.1:8080/healthz",
		"10.0.0.5:8080":  "http://10.0.0.5:8080/healthz",
		"[::1]:8080":     "http://[::1]:8080/healthz",
		"localhost:8080": "http://localhost:8080/healthz",
	} {
		if got, err := probeURL(listen, false); err != nil || got != want {
			t.Errorf("%s: %s %v", listen, got, err)
		}
	}
	if got, _ := probeURL(":8080", true); got != "http://127.0.0.1:8080/readyz" {
		t.Error(got)
	}
	for _, listen := range []string{"127.0.0.1:0", "127.0.0.1", ""} {
		if got, err := probeURL(listen, false); err == nil {
			t.Errorf("%q: %s", listen, got)
		}
	}
}

// startHosted runs the hosted server with local users and returns its
// address and output; stop ends it and returns the exit code.
func startHosted(t *testing.T, extra ...string) (addr string, stderr *syncBuffer, stop func() int) {
	t.Helper()
	args := append([]string{"--mode", "hosted", "--listen", "127.0.0.1:0", "--public-url", "https://explorer.example.com", "--data-dir", t.TempDir()}, extra...)
	stdout, stderr := &syncBuffer{}, &syncBuffer{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int, 1)
	go func() { done <- run(ctx, args, stdout, stderr, nil) }()
	listening := regexp.MustCompile(`listening on (127\.0\.0\.1:[0-9]+) for`)
	for deadline := time.Now().Add(5 * time.Second); addr == "" && time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if m := listening.FindStringSubmatch(stderr.String()); m != nil {
			addr = m[1]
		}
	}
	if addr == "" {
		cancel()
		t.Fatalf("not listening: %s %s", stdout, stderr)
	}
	return addr, stderr, func() int { cancel(); return <-done }
}

func TestHealthcheck(t *testing.T) {
	addr, _, stop := startHosted(t)
	check := func(args ...string) (int, string) {
		var out, errOut bytes.Buffer
		code := runHealthcheck(context.Background(), args, &out, &errOut)
		return code, out.String() + errOut.String()
	}
	if code, out := check("--listen", addr); code != 0 || out != "ok\n" {
		t.Errorf("healthz: %d %q", code, out)
	}
	t.Setenv("IONOS_EXPLORER_LISTEN", addr)
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:9") // not used
	if code, out := check("--ready"); code != 0 || out != "ok\n" {
		t.Errorf("readyz from the environment: %d %q", code, out)
	}
	stop()
	if code, out := check(); code != 1 || !strings.Contains(out, "connection refused") {
		t.Errorf("stopped: %d %q", code, out)
	}

	unready := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not ready: shutting down", http.StatusServiceUnavailable)
	}))
	defer unready.Close()
	if code, out := check("--ready", "--listen", unready.Listener.Addr().String()); code != 1 || !strings.Contains(out, "503 not ready: shutting down") {
		t.Errorf("not ready: %d %q", code, out)
	}
	if code, _ := check("extra"); code != 1 {
		t.Error("argument accepted")
	}
}

func TestJSONLogFormat(t *testing.T) {
	_, stderr, stop := startHosted(t, "--log-format", "json")
	if code := stop(); code != 0 {
		t.Fatalf("exit %d", code)
	}
	var lines int
	sc := bufio.NewScanner(strings.NewReader(stderr.String()))
	for sc.Scan() {
		var line map[string]string
		if err := json.Unmarshal(sc.Bytes(), &line); err != nil || line["msg"] == "" || line["level"] == "" {
			t.Errorf("not a log object: %q", sc.Text())
		}
		lines++
	}
	if lines < 3 { // setup link, listening, stopping
		t.Errorf("%d lines: %s", lines, stderr)
	}

	var out, errOut bytes.Buffer
	if code := run(context.Background(), []string{"--log-format", "xml"}, &out, &errOut, nil); code != 1 || !strings.Contains(errOut.String(), "text or json") {
		t.Errorf("%d %s", code, errOut.String())
	}
}

func TestEnvFromFile(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) string {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	parse := func(args ...string) (*flag.FlagSet, error) {
		fs := flag.NewFlagSet("test", flag.ContinueOnError)
		fs.String("public-url", "", "")
		fs.String("admin-password-file", "", "")
		if err := fs.Parse(args); err != nil {
			t.Fatal(err)
		}
		_, err := fromEnv(fs, nil)
		return fs, err
	}
	value := func(fs *flag.FlagSet, name string) string { return fs.Lookup(name).Value.String() }

	// One trailing line break goes, everything else stays.
	t.Setenv("IONOS_EXPLORER_PUBLIC_URL_FILE", write("url", "https://explorer.example.com \r\n"))
	if fs, err := parse(); err != nil || value(fs, "public-url") != "https://explorer.example.com " {
		t.Errorf("%q %v", value(fs, "public-url"), err)
	}
	// A flag wins; the file is not read.
	t.Setenv("IONOS_EXPLORER_PUBLIC_URL_FILE", filepath.Join(dir, "missing"))
	if fs, err := parse("--public-url", "https://flag.example.com"); err != nil || value(fs, "public-url") != "https://flag.example.com" {
		t.Errorf("%q %v", value(fs, "public-url"), err)
	}
	if _, err := parse(); err == nil || !strings.HasPrefix(err.Error(), "IONOS_EXPLORER_PUBLIC_URL_FILE: ") {
		t.Errorf("missing file: %v", err)
	}
	// Both ways at once is a mistake.
	t.Setenv("IONOS_EXPLORER_PUBLIC_URL_FILE", write("url2", "https://a.example.com"))
	t.Setenv("IONOS_EXPLORER_PUBLIC_URL", "https://b.example.com")
	if _, err := parse(); err == nil || !strings.Contains(err.Error(), "both set") {
		t.Errorf("both: %v", err)
	}
	// A flag that names a file has no _FILE of its own (no _FILE_FILE).
	os.Unsetenv("IONOS_EXPLORER_PUBLIC_URL")
	os.Unsetenv("IONOS_EXPLORER_PUBLIC_URL_FILE")
	t.Setenv("IONOS_EXPLORER_ADMIN_PASSWORD_FILE", "/run/secrets/admin")
	t.Setenv("IONOS_EXPLORER_ADMIN_PASSWORD_FILE_FILE", write("x", "/elsewhere"))
	if fs, err := parse(); err != nil || value(fs, "admin-password-file") != "/run/secrets/admin" {
		t.Errorf("%q %v", value(fs, "admin-password-file"), err)
	}
}
