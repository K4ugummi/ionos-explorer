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
	"testing"
	"time"

	"github.com/K4ugummi/ionos-explorer/exporter/internal/history"
	"github.com/K4ugummi/ionos-explorer/exporter/internal/users"
)

func init() { usersOptions = users.Options{Params: users.Params{Memory: 64, Time: 1, Threads: 1}} }

const password = "correct horse battery"

// usersCmd runs "ionos-explorer users …" with input on stdin.
func usersCmd(t *testing.T, input string, args ...string) (int, string, string) {
	t.Helper()
	stdin = strings.NewReader(input)
	t.Cleanup(func() { stdin = os.Stdin })
	var stdout, stderr bytes.Buffer
	code := run(context.Background(), append([]string{"users"}, args...), &stdout, &stderr, nil)
	return code, stdout.String(), stderr.String()
}

var linkPattern = regexp.MustCompile(`https://explorer\.example\.com/#link=[A-Za-z0-9_-]{43}`)

func TestUsersCommand(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("IONOS_EXPLORER_DATA_DIR", dir)
	t.Setenv("IONOS_EXPLORER_NAME", "not a flag source") // only data-dir and public-url come from the environment
	if code, out, _ := usersCmd(t, "", "list"); code != 0 || !strings.Contains(out, "No accounts yet") {
		t.Errorf("%d %s", code, out)
	}
	if code, out, errOut := usersCmd(t, password+"\n", "add", "Root", "--role", "admin", "--password-stdin"); code != 0 || !strings.Contains(out, "Added root (admin).") {
		t.Fatalf("%d %s %s", code, out, errOut)
	}
	// Flags after the username too; a link with the public URL.
	code, out, errOut := usersCmd(t, "", "add", "bob", "--name", "Bob B.", "--public-url", "https://explorer.example.com")
	if code != 0 || !linkPattern.MatchString(out) {
		t.Fatalf("%d %s %s", code, out, errOut)
	}
	if code, out, _ := usersCmd(t, "", "add", "carol"); code != 0 || !strings.Contains(out, "<public URL>/#link=") {
		t.Errorf("%d %s", code, out)
	}
	code, out, _ = usersCmd(t, "", "list")
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if code != 0 || len(lines) != 4 || !strings.Contains(lines[1], "Bob B.") || !strings.Contains(lines[1], "no password yet") ||
		!strings.Contains(lines[3], "root") || !strings.Contains(lines[3], "enabled") || strings.Contains(out, "not a flag source") {
		t.Errorf("%s", out)
	}
	for _, c := range []struct {
		args  []string
		input string
		want  string
	}{
		{[]string{"disable", "root"}, "", "last enabled admin"},
		{[]string{"role", "root", "user"}, "", "last enabled admin"},
		{[]string{"delete", "root"}, "", "last enabled admin"},
		{[]string{"add", "root"}, "", "taken"},
		{[]string{"add", "dave", "--password-stdin"}, "short\n", "at least 12"},
		{[]string{"reset", "nobody"}, "", "no such user"},
		{[]string{"promote", "bob"}, "", "unknown command"},
		{[]string{"role", "bob"}, "", "wrong number of arguments"},
		{[]string{"disable", "bob", "--password-stdin"}, "", "for add and reset"},
		{[]string{"list", "--data-dir", "/nonexistent/x"}, "", "not found"},
		{[]string{"add", "eve", "--public-url", "http://example.com"}, "", "https is required"},
	} {
		if code, out, errOut := usersCmd(t, c.input, c.args...); code != 1 || !strings.Contains(errOut, c.want) {
			t.Errorf("%v: %d %s %s", c.args, code, out, errOut)
		}
	}
	// Carol has a snapshot history; deleting her deletes it.
	before, err := users.Open(dir, usersOptions)
	if err != nil {
		t.Fatal(err)
	}
	carol, _ := before.Find("carol")
	carolHistory := filepath.Join(history.Root(dir), history.Scope("local:"+carol.ID), "1")
	if err := os.MkdirAll(carolHistory, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"role", "bob", "admin"}, {"disable", "root"}, {"enable", "root"}, {"delete", "carol"}} {
		if code, out, errOut := usersCmd(t, "", args...); code != 0 {
			t.Errorf("%v: %d %s %s", args, code, out, errOut)
		}
	}
	if code, out, _ := usersCmd(t, password+" 2\r\n", "reset", "bob", "--password-stdin"); code != 0 || !strings.Contains(out, "Password of bob set") {
		t.Errorf("%d %s", code, out)
	}
	store, err := users.Open(dir, usersOptions)
	if err != nil {
		t.Fatal(err)
	}
	if u, err := store.Login(context.Background(), "bob", password+" 2"); err != nil || u.Role != users.RoleAdmin {
		t.Errorf("%+v %v", u, err)
	}
	if _, found := store.Find("carol"); found {
		t.Error("carol not deleted")
	}
	if _, err := os.Stat(filepath.Dir(carolHistory)); !os.IsNotExist(err) {
		t.Error("carol's history is left", err)
	}
	if code, _, errOut := usersCmd(t, ""); code != 1 || !strings.Contains(errOut, "Commands:") {
		t.Error(errOut)
	}
}

func TestFirstAdminFromFile(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(t.TempDir(), "admin_password")
	if err := os.WriteFile(file, []byte(password+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	args := []string{"--mode", "hosted", "--listen", "127.0.0.1:0", "--public-url", "https://explorer.example.com", "--data-dir", dir,
		"--admin-username", "Boss", "--admin-password-file", file}
	stdout, stderr := &syncBuffer{}, &syncBuffer{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int, 1)
	go func() { done <- run(ctx, args, stdout, stderr, nil) }()
	listening := regexp.MustCompile(`listening on (127\.0\.0\.1:[0-9]+) for`)
	var addr string
	for deadline := time.Now().Add(5 * time.Second); addr == "" && time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if m := listening.FindStringSubmatch(stderr.String()); m != nil {
			addr = m[1]
		}
	}
	if addr == "" {
		t.Fatalf("%s %s", stdout, stderr)
	}
	if !strings.Contains(stderr.String(), `First admin "boss" created`) || strings.Contains(stderr.String(), "#setup=") || strings.Contains(stderr.String(), password) {
		t.Errorf("%s", stderr)
	}
	req, _ := http.NewRequest("POST", "http://"+addr+"/api/login", strings.NewReader(`{"username":"boss","password":"`+password+`"}`))
	req.Host = "explorer.example.com"
	req.Header.Set("Origin", "https://explorer.example.com")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Ionos-Explorer", "login")
	resp, err := http.DefaultTransport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || !strings.Contains(string(body), `"mustChangePassword":true`) {
		t.Errorf("%d %s", resp.StatusCode, body)
	}
	cancel()
	<-done

	// A second start: the users exist, the file changes nothing.
	if err := os.WriteFile(file, []byte("another password entirely"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	ctx, cancel = context.WithCancel(context.Background())
	go func() { time.Sleep(300 * time.Millisecond); cancel() }()
	if code := run(ctx, args, &out, &errOut, nil); code != 0 || strings.Contains(errOut.String(), "First admin") {
		t.Errorf("%d %s", code, errOut.String())
	}
	// A weak password in the file: refused at start.
	if err := os.WriteFile(file, []byte("admin"), 0o600); err != nil {
		t.Fatal(err)
	}
	errOut.Reset()
	if code := run(context.Background(), append(args[:len(args)-6:len(args)-6], "--data-dir", t.TempDir(), "--admin-username", "boss", "--admin-password-file", file), &out, &errOut, nil); code != 1 ||
		!strings.Contains(errOut.String(), "at least 12") {
		t.Errorf("%d %s", code, errOut.String())
	}
}

func TestDataDirNotWritable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes anyway")
	}
	dir := t.TempDir()
	os.Chmod(dir, 0o500)
	defer os.Chmod(dir, 0o700)
	var out, errOut bytes.Buffer
	args := []string{"--mode", "hosted", "--listen", "127.0.0.1:0", "--public-url", "https://explorer.example.com", "--data-dir", dir}
	if code := run(context.Background(), args, &out, &errOut, nil); code != 1 || !strings.Contains(errOut.String(), "must be writable for this program's user (uid ") {
		t.Errorf("%d %s", code, errOut.String())
	}
}
