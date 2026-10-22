// Command ionos-explorer serves the explorer UI on 127.0.0.1 and fetches
// the IONOS Cloud contract itself when asked in the UI: the same read-only
// crawl as ionos-export (GET requests only, to the endpoints listed in
// internal/endpoints), with the token typed into the page and the result
// kept in memory until the browser takes it. With --mode hosted it serves a
// team instead, behind a proxy that terminates TLS.
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
	"strings"
	"sync"
	"syscall"
	"time"

	"filippo.io/age"

	"github.com/K4ugummi/ionos-explorer/exporter/internal/history"
	"github.com/K4ugummi/ionos-explorer/exporter/internal/server"
	"github.com/K4ugummi/ionos-explorer/exporter/internal/users"
	"github.com/K4ugummi/ionos-explorer/exporter/internal/webui"
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

With --mode hosted it serves a team instead: on any address, behind a proxy
that terminates TLS, each user logged in with a session of their own. User
accounts are kept in the data directory; "ionos-explorer users" manages
them from the command line (see "ionos-explorer users -h"). OpenID Connect
providers (Keycloak, Entra ID, Google, …) can be added for login, next to
local users or instead of them (--oidc-providers).
"ionos-explorer healthcheck" asks a running server whether it is alive.
With an age identity (--age-identity-file; "ionos-explorer keygen" makes
one) every fetch is also kept, encrypted, in the user's own history in the
data directory; "ionos-explorer rekey" moves it to a new key.

Every flag can also be set in the environment: IONOS_EXPLORER_ and the flag
name in capitals, - as _ (IONOS_EXPLORER_PUBLIC_URL), or read from a file
that the same name with _FILE names (a Docker or Kubernetes secret). A flag
wins.

Flags:
`

// envPrefix starts the environment variable of every flag.
const envPrefix = "IONOS_EXPLORER_"

// hostedOnly are the flags that mean nothing in local mode.
var hostedOnly = []string{"public-url", "max-fetches", "session-ttl", "session-idle", "data-dir", "local-users", "admin-username", "admin-password-file",
	"age-identity-file", "keep", "max-user-bytes", "local-totp", "oidc-providers"}

// usersOptions are the store's options (tests make hashing cheap).
var usersOptions = users.Options{}

func run(ctx context.Context, args []string, stdout, stderr io.Writer, open func(string) error) int {
	if len(args) > 0 {
		switch args[0] {
		case "users":
			return runUsers(ctx, args[1:], stdin, stdout, stderr)
		case "healthcheck":
			return runHealthcheck(ctx, args[1:], stdout, stderr)
		case "keygen":
			return runKeygen(args[1:], stdout, stderr)
		case "rekey":
			return runRekey(args[1:], stdout, stderr)
		}
	}
	fs := flag.NewFlagSet("ionos-explorer", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var (
		mode        = fs.String("mode", "local", "local: this machine, one user; hosted: a team, behind a TLS proxy")
		listen      = fs.String("listen", "", "address to listen on (local: loopback only, default 127.0.0.1:0, port 0: a free one; hosted: default :8080)")
		openFlag    = fs.Bool("open", true, "open the browser (local)")
		baseURL     = fs.String("base-url", "", "send all API requests to this URL instead of the IONOS API hosts (for a local mock)")
		forgetAfter = fs.Duration("forget-after", 30*time.Minute, "forget a held API token after this long unused (0: only on Forget or exit)")
		publicURL   = fs.String("public-url", "", "hosted: the address users open, https://explorer.example.com or with a path")
		maxFetches  = fs.Int("max-fetches", 2, "hosted: fetches running at once over all users")
		sessionTTL  = fs.Duration("session-ttl", 12*time.Hour, "hosted: a login lasts this long")
		sessionIdle = fs.Duration("session-idle", 2*time.Hour, "hosted: a login ends after this long without a request")
		dataDir     = fs.String("data-dir", "/data", "hosted: the directory for user accounts and the snapshot history; must exist")
		localUsers  = fs.Bool("local-users", true, "hosted: user accounts kept by the explorer (false: OIDC providers only)")
		adminUser   = fs.String("admin-username", "admin", "hosted: the first admin's username, with --admin-password-file")
		adminPWFile = fs.String("admin-password-file", "", "hosted: create the first admin with the password in this file (if there are no users yet); it must be changed at the first login")
		ageIDFile   = fs.String("age-identity-file", "", "hosted: the age identities (AGE-SECRET-KEY-1…, one per line, the first encrypts) that keep every fetch in the user's history; none: no history")
		oidcList    = fs.String("oidc-providers", "", "hosted: OIDC login providers, comma-separated IDs (keycloak,entra); each set up by IONOS_EXPLORER_OIDC_<ID>_ISSUER, _CLIENT_ID, _CLIENT_SECRET and more (see deploy/README.md)")
		localTOTP   = fs.String("local-totp", server.TOTPOptional, "hosted: second factor (TOTP) for local users: off, optional or required (needs --age-identity-file, which keeps the secrets)")
		keep        = fs.String("keep", history.DefaultKeep.String(), "hosted: history retention per user and contract, besides the newest 3")
		maxUser     = fs.String("max-user-bytes", "500MB", "hosted: the most a user's history may take (KB, MB, GB; 0: no limit)")
		logFormat   = fs.String("log-format", "text", "text, or json: one JSON object per line, for a log collector")
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
	set, err := fromEnv(fs, nil)
	if err != nil {
		return fail("%v", err)
	}
	if *logFormat != "text" && *logFormat != "json" {
		return fail("--log-format %q: text or json", *logFormat)
	}
	logger := server.NewLogger(stderr, *logFormat == "json")
	var hosted *server.Hosted
	switch *mode {
	case "local":
		for _, name := range hostedOnly {
			if set[name] {
				return fail("--%s is for --mode hosted", name)
			}
		}
		if *listen == "" {
			*listen = "127.0.0.1:0"
		}
		if err := server.CheckListen(*listen); err != nil {
			return fail("%v", err)
		}
	case "hosted":
		if *listen == "" {
			*listen = ":8080"
		}
		if _, err := server.ParsePublicURL(*publicURL); err != nil {
			return fail("%v", err)
		}
		var ids []*age.X25519Identity
		if *ageIDFile != "" {
			if ids, err = readIdentities(*ageIDFile); err != nil {
				return fail("%v", err)
			}
		}
		var store *users.Store
		if *localUsers {
			if store, err = openUsers(*dataDir, ids); err != nil {
				return fail("%v", err)
			}
			switch {
			case *localTOTP == server.TOTPRequired && ids == nil:
				return fail("--local-totp required needs --age-identity-file (IONOS_EXPLORER_AGE_IDENTITY_FILE), which keeps the secrets")
			case ids == nil && store.HasTOTP():
				logger.Error("Some accounts have a second factor, but there is no --age-identity-file to check it with: they cannot log in until it is set (or \"ionos-explorer users reset-totp\" removes their second factor).")
			case ids == nil && *localTOTP == server.TOTPOptional:
				logger.Print("Two-factor authentication is not offered: it needs --age-identity-file (IONOS_EXPLORER_AGE_IDENTITY_FILE) to keep the keys of the authenticator apps.")
			}
			if *adminPWFile != "" {
				if err := firstAdmin(ctx, store, *adminUser, *adminPWFile, logger); err != nil {
					return fail("%v", err)
				}
			}
		}
		auth, err := newAuth(ctx, *oidcList, *publicURL, logger)
		if err != nil {
			return fail("%v", err)
		}
		if store == nil && len(auth) == 0 {
			return fail("hosted mode needs a login method: local users (--local-users) or an OIDC provider")
		}
		hist, err := openHistory(*dataDir, ids, *keep, *maxUser)
		if err != nil {
			return fail("%v", err)
		}
		if hist == nil {
			logger.Print("No snapshot history: without --age-identity-file (IONOS_EXPLORER_AGE_IDENTITY_FILE) fetches are kept in memory only, until the user takes them.")
		}
		hosted = &server.Hosted{PublicURL: *publicURL, Users: store, Auth: auth, MaxFetches: *maxFetches, SessionTTL: *sessionTTL, SessionIdle: *sessionIdle,
			History: hist, TOTP: *localTOTP}
	default:
		return fail("--mode %q: local or hosted", *mode)
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
		Hosted:      hosted,
		UI:          ui,
		BaseURL:     *baseURL,
		Version:     buildVersion(),
		ForgetAfter: *forgetAfter,
		Log:         stderr,
		LogJSON:     *logFormat == "json",
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
		logger.Error("Built without the UI (make explorer-app embeds it); the page only says so.")
	}
	if hosted != nil {
		kept := "Tokens and fetched data stay in memory, per session"
		if hosted.History != nil {
			kept = "Tokens stay in memory, per session; fetches are also kept encrypted in each user's history"
		}
		logger.Print(fmt.Sprintf("IONOS Explorer %s (hosted) is listening on %s for %s. %s; a restart logs everyone out.",
			buildVersion(), ln.Addr(), hosted.PublicURL, kept))
		return wait(ctx, served, srv, hs, logger)
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

	return wait(ctx, served, srv, hs, logger)
}

// shutdownGrace is how long requests under way (a snapshot download) may
// take after a stop signal; Kubernetes waits 30 s by default.
const shutdownGrace = 10 * time.Second

// wait serves until ctx ends (SIGTERM, Ctrl+C), then cancels the fetches,
// drops the tokens and data, and lets the requests under way end.
func wait(ctx context.Context, served chan error, srv *server.Server, hs *http.Server, logger *server.Logger) int {
	select {
	case <-ctx.Done():
	case err := <-served:
		logger.Error(err.Error())
		return 1
	}
	logger.Print("Stopping; tokens and any fetched data are dropped.")
	srv.Close()
	shut, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	_ = hs.Shutdown(shut)
	return 0
}

// fromEnv sets every flag not given on the command line (of those in
// only, if not nil) from its environment variable, or from the file that
// variable with _FILE names (a Docker or Kubernetes secret; one trailing
// line break is dropped), and reports which flags are set either way.
func fromEnv(fs *flag.FlagSet, only map[string]bool) (map[string]bool, error) {
	set := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { set[f.Name] = true })
	var err error
	fs.VisitAll(func(f *flag.Flag) {
		if err != nil || set[f.Name] || f.Name == "version" || only != nil && !only[f.Name] {
			return
		}
		name := envPrefix + strings.ToUpper(strings.ReplaceAll(f.Name, "-", "_"))
		v, ok := os.LookupEnv(name)
		// A flag naming a file takes no file of its own.
		if file, fromFile := os.LookupEnv(name + "_FILE"); fromFile && !strings.HasSuffix(f.Name, "-file") {
			if ok {
				err = fmt.Errorf("%s and %s_FILE are both set; use one", name, name)
				return
			}
			data, e := os.ReadFile(file)
			if e != nil {
				err = fmt.Errorf("%s_FILE: %v", name, e)
				return
			}
			v, ok = strings.TrimSuffix(strings.TrimSuffix(string(data), "\n"), "\r"), true
			clear(data)
			name += "_FILE"
		}
		if !ok {
			return
		}
		if e := fs.Set(f.Name, v); e != nil {
			err = fmt.Errorf("%s: %v", name, e)
		}
		set[f.Name] = true
	})
	return set, err
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
