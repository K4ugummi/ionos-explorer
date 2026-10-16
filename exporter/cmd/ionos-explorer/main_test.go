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
	if !strings.Contains(stdout.String(), "nothing is written to disk") || !strings.Contains(stderr.String(), "built without the UI") ||
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
