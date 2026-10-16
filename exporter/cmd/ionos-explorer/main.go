// Command ionos-explorer serves the explorer UI on 127.0.0.1 and fetches
// the IONOS Cloud contract itself when asked in the UI: the same read-only
// crawl as ionos-export (GET requests only, to the endpoints listed in
// internal/endpoints), with the token typed into the page and the result
// kept in memory until the browser takes it.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"sync"
	"syscall"
	"time"

	"ionos-explorer/exporter/internal/server"
	"ionos-explorer/exporter/internal/webui"
)

var version = "dev"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := run(ctx, os.Args[1:], os.Stdout, os.Stderr, openBrowser)
	stop()
	os.Exit(code)
}

const usage = `Usage: ionos-explorer [flags]

Serves IONOS Explorer on this machine (127.0.0.1 only) and opens it in the
browser. In the page you can open snapshot files, or enter an API token and
fetch the contract directly: GET requests only, the token is kept in this
program's memory only, and the fetched data stays in memory until you
download it. Stop with Ctrl+C.

Flags:
`

func run(ctx context.Context, args []string, stdout, stderr io.Writer, open func(string) error) int {
	fs := flag.NewFlagSet("ionos-explorer", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var (
		listen      = fs.String("listen", "127.0.0.1:0", "address to listen on, loopback only (port 0: a free one)")
		openFlag    = fs.Bool("open", true, "open the browser")
		baseURL     = fs.String("base-url", "", "send all API requests to this URL instead of the IONOS API hosts (for a local mock)")
		forgetAfter = fs.Duration("forget-after", 30*time.Minute, "forget a held API token after this long unused (0: only on Forget or exit)")
		showVersion = fs.Bool("version", false, "print the version and exit")
	)
	fs.Usage = func() {
		fmt.Fprint(stderr, usage)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 1
	}
	fail := func(format string, a ...any) int {
		fmt.Fprintf(stderr, "ionos-explorer: "+format+"\n", a...)
		return 1
	}
	if fs.NArg() > 0 {
		// Not echoed: it might be a token pasted in the wrong place.
		return fail("unexpected argument; the API token is entered in the browser, never on the command line")
	}
	if *showVersion {
		fmt.Fprintln(stdout, "ionos-explorer", buildVersion())
		return 0
	}
	if err := server.CheckListen(*listen); err != nil {
		return fail("%v", err)
	}

	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		return fail("%v", err)
	}
	defer ln.Close()
	ui, real := webui.FS()
	var launcher launchFile
	srv, err := server.New(server.Options{
		Addr:        ln.Addr().String(),
		UI:          ui,
		BaseURL:     *baseURL,
		Version:     buildVersion(),
		ForgetAfter: *forgetAfter,
		Log:         stderr,
		OnLogin:     launcher.remove,
	})
	if err != nil {
		return fail("%v", err)
	}
	defer srv.Close()
	defer launcher.removeNow()

	hs := &http.Server{
		Handler:           srv,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      2 * time.Minute,
		IdleTimeout:       2 * time.Minute,
	}
	served := make(chan error, 1)
	go func() { served <- hs.Serve(ln) }()

	if !real {
		fmt.Fprintln(stderr, "ionos-explorer: built without the UI (make explorer-app embeds it); the page only says so.")
	}
	fmt.Fprintf(stdout, "IONOS Explorer is running. Open this link to log the browser in (keep it to yourself):\n\n  %s\n\n", srv.LoginURL())
	fmt.Fprintln(stdout, "Fetched data stays in memory; nothing is written to disk unless you download it. Ctrl+C stops.")
	if *openFlag {
		// The secret goes into a private file, not onto a command line that
		// other users of this machine can list.
		if err := launcher.create(srv.LoginURL()); err != nil {
			fmt.Fprintf(stderr, "ionos-explorer: could not open the browser (%v); open the link above.\n", err)
		} else if err := open(launcher.file()); err != nil {
			fmt.Fprintf(stderr, "ionos-explorer: could not open the browser (%v); open the link above.\n", err)
			launcher.removeNow()
		}
	}

	select {
	case <-ctx.Done():
	case err := <-served:
		return fail("%v", err)
	}
	fmt.Fprintln(stderr, "Stopping; the token and any fetched data are dropped.")
	srv.Close()
	shut, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = hs.Shutdown(shut)
	return 0
}

// launchFile is a page that forwards to the login URL, readable only by
// this user, removed after the first login or on exit.
type launchFile struct {
	mu   sync.Mutex
	dir  string
	path string
}

func (l *launchFile) create(loginURL string) error {
	dir, err := os.MkdirTemp("", "ionos-explorer-") // 0700
	if err != nil {
		return err
	}
	path := filepath.Join(dir, "open.html")
	u := html.EscapeString(loginURL)
	page := `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">` +
		`<meta http-equiv="refresh" content="0; url=` + u + `"><title>IONOS Explorer</title></head>` +
		`<body><p><a href="` + u + `">Open IONOS Explorer</a></p></body></html>`
	if err := os.WriteFile(path, []byte(page), 0o600); err != nil {
		os.RemoveAll(dir)
		return err
	}
	l.mu.Lock()
	l.dir, l.path = dir, path
	l.mu.Unlock()
	return nil
}

func (l *launchFile) file() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.path
}

// remove removes the file soon: the browser may still be reading it.
func (l *launchFile) remove() { time.AfterFunc(2*time.Second, l.removeNow) }

func (l *launchFile) removeNow() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.dir != "" {
		os.RemoveAll(l.dir)
		l.dir, l.path = "", ""
	}
}

func openBrowser(target string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", target)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", target)
	default:
		cmd = exec.Command("xdg-open", target)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

func buildVersion() string {
	if version != "dev" {
		return version
	}
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, s := range info.Settings {
			if s.Key == "vcs.revision" && len(s.Value) >= 12 {
				return "dev-" + s.Value[:12]
			}
		}
	}
	return version
}
