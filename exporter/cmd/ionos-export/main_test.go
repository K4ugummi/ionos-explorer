package main

import (
	"bytes"
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"filippo.io/age"

	"ionos-explorer/exporter/internal/fakeapi"
	"ionos-explorer/exporter/internal/snapshot"
)

const token = "cli-test-token-abcdef"

func env(vars map[string]string) func(string) string {
	return func(k string) string { return vars[k] }
}

func cli(t *testing.T, args []string, vars map[string]string) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := run(context.Background(), args, &stdout, &stderr, env(vars))
	if strings.Contains(stdout.String()+stderr.String(), token) {
		t.Fatal("the token was printed")
	}
	return code, stdout.String(), stderr.String()
}

func fake(t *testing.T) *httptest.Server {
	t.Helper()
	demo, err := fakeapi.Demo()
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(&fakeapi.Server{Snap: demo, Token: token, PageSize: 5, Errorf: t.Errorf})
	t.Cleanup(srv.Close)
	return srv
}

func TestExportEndToEnd(t *testing.T) {
	srv := fake(t)
	dir := t.TempDir()
	out := filepath.Join(dir, "c.ionx")
	code, _, stderr := cli(t, []string{"--base-url", srv.URL, "-o", out}, map[string]string{"IONOS_TOKEN": token})
	// The demo contract hides users and groups from the exporting user.
	if code != exitPartial {
		t.Fatalf("exit %d\n%s", code, stderr)
	}
	for _, want := range []string{"Contract 31812345, 14 datacenters,", "forbidden cloudapi-v6 /um/users", "Wrote " + out} {
		if !strings.Contains(stderr, want) {
			t.Errorf("missing %q in\n%s", want, stderr)
		}
	}
	info, err := os.Stat(out)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("%v %v", err, info)
	}
	b, _ := os.ReadFile(out)
	if bytes.Contains(b, []byte(token)) {
		t.Fatal("token in snapshot")
	}
	s, err := snapshot.Read(bytes.NewReader(b))
	if err != nil || s.Manifest.Generator.Name != "ionos-export" || len(s.Files) < 80 {
		t.Fatalf("%v %+v", err, s.Manifest.Generator)
	}

	// No overwrite without --force, and the check happens before any request.
	code, _, stderr = cli(t, []string{"--base-url", "http://127.0.0.1:1", "-o", out}, map[string]string{"IONOS_TOKEN": token})
	if code != exitFailed || !strings.Contains(stderr, "exists") {
		t.Errorf("exit %d: %s", code, stderr)
	}

	// Skipping what is forbidden gives a complete export; encrypted to a recipient.
	id, _ := age.GenerateX25519Identity()
	code, _, stderr = cli(t, []string{"--base-url", srv.URL, "-o", out, "--force", "--skip", "/um", "--recipient", id.Recipient().String()},
		map[string]string{"IONOS_USERNAME": "x", "IONOS_PASSWORD": "y", "IONOS_TOKEN": token})
	if code != 0 || !strings.Contains(stderr, "encrypted") {
		t.Fatalf("exit %d\n%s", code, stderr)
	}
	b, _ = os.ReadFile(out)
	if _, err := snapshot.Read(bytes.NewReader(b)); err != snapshot.ErrEncrypted {
		t.Errorf("expected an encrypted snapshot, got %v", err)
	}
	if _, err := snapshot.Read(bytes.NewReader(b), id); err != nil {
		t.Error(err)
	}

	// Default file name from the contract and time, next to nothing else.
	t.Chdir(dir)
	code, _, stderr = cli(t, []string{"--base-url", srv.URL, "--skip", "/um"}, map[string]string{"IONOS_TOKEN": token})
	matches, _ := filepath.Glob(filepath.Join(dir, "ionos-31812345-*Z.ionx"))
	if code != 0 || len(matches) != 1 {
		t.Errorf("exit %d, files %v\n%s", code, matches, stderr)
	}
	leftovers, _ := filepath.Glob(filepath.Join(dir, ".ionos-export-*"))
	if len(leftovers) > 0 {
		t.Errorf("temp files left: %v", leftovers)
	}
}

func TestBadCredentials(t *testing.T) {
	srv := fake(t)
	code, _, stderr := cli(t, []string{"--base-url", srv.URL, "-o", filepath.Join(t.TempDir(), "x.ionx")}, map[string]string{"IONOS_TOKEN": "nope"})
	if code != exitFailed || !strings.Contains(stderr, "rejected the credentials") {
		t.Errorf("exit %d: %s", code, stderr)
	}
}

func TestFlagsAndCredentials(t *testing.T) {
	dir := t.TempDir()
	tokenFile := filepath.Join(dir, "token")
	_ = os.WriteFile(tokenFile, []byte(token+"\n"), 0o600)
	empty := filepath.Join(dir, "empty")
	_ = os.WriteFile(empty, nil, 0o600)

	c, err := credentials(tokenFile, env(map[string]string{"IONOS_TOKEN": "other"}))
	if err != nil || c.Token != token {
		t.Errorf("token file: %v", err)
	}
	if c, _ := credentials("", env(map[string]string{"IONOS_TOKEN": " t ", "IONOS_USERNAME": "u"})); c.Token != "t" {
		t.Error("IONOS_TOKEN should win over username and password")
	}
	for _, bad := range []struct {
		file string
		vars map[string]string
	}{
		{"", nil},
		{empty, nil},
		{"", map[string]string{"IONOS_USERNAME": "u"}},
		{filepath.Join(dir, "missing"), nil},
	} {
		if _, err := credentials(bad.file, env(bad.vars)); err == nil {
			t.Errorf("accepted %+v", bad)
		}
	}

	for _, args := range [][]string{
		{token},                      // a secret passed as an argument is refused
		{"--base-url", "ftp://x"},    // not http(s)
		{"--passphrase-file", empty}, // empty passphrase
		{"--recipient", "age1nope"},  // invalid recipient
		{"--no-such-flag"},           // unknown flag
	} {
		if code, _, _ := cli(t, args, map[string]string{"IONOS_TOKEN": "x"}); code != exitFailed {
			t.Errorf("%v: exit %d", args, code)
		}
	}
	if code, _, stderr := cli(t, nil, nil); code != exitFailed || !strings.Contains(stderr, "no credentials") {
		t.Errorf("no credentials: %d %s", code, stderr)
	}
}

func TestList(t *testing.T) {
	// --list needs neither credentials nor network.
	code, stdout, _ := cli(t, []string{"--list"}, nil)
	if code != 0 || !strings.Contains(stdout, "only GET requests, only to api.ionos.com, postgresql.de-fra.ionos.com,") ||
		!strings.Contains(stdout, "GET /datacenters/{datacenterId}/servers?depth=5") ||
		!strings.Contains(stdout, "https://postgresql.gb-bhx.ionos.com (DBaaS PostgreSQL v2)") {
		t.Errorf("exit %d\n%s", code, stdout)
	}
	code, stdout, _ = cli(t, []string{"--list", "--base-url", "http://127.0.0.1:9/"}, nil)
	if code != 0 || !strings.Contains(stdout, "http://127.0.0.1:9/api.ionos.com/cloudapi/v6 (Cloud API v6)") {
		t.Errorf("exit %d\n%s", code, stdout)
	}
}
