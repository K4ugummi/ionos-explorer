// Command ionos-export reads an IONOS Cloud contract through the API and
// writes a snapshot (.ionx) for the explorer. It only sends GET requests to
// the endpoints listed in internal/endpoints (see --list).
package main

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/K4ugummi/ionos-explorer/exporter/internal/endpoints"
	"github.com/K4ugummi/ionos-explorer/exporter/internal/export"
	"github.com/K4ugummi/ionos-explorer/exporter/internal/httpx"
	"github.com/K4ugummi/ionos-explorer/exporter/internal/snapshot"
)

var version = "dev"

// Exit codes: 0 complete, 1 failed (nothing written), 2 written but partial.
const (
	exitFailed  = 1
	exitPartial = 2
)

type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := run(ctx, os.Args[1:], os.Stdout, os.Stderr, os.Getenv)
	stop()
	os.Exit(code)
}

const usage = `Usage: ionos-export [flags]

Reads your IONOS Cloud contract (GET requests only) and writes a snapshot
file for the explorer.

Credentials, first match wins (never pass them as arguments):
  --token-file FILE                 file containing an API token
  IONOS_TOKEN                       environment variable with an API token
  IONOS_USERNAME + IONOS_PASSWORD   environment variables

Use a dedicated user with read access to all datacenters. Endpoints the user
may not read are recorded in the snapshot as "forbidden"; the explorer shows
them as partial visibility.

Exit codes: 0 complete, 2 written but partial, 1 failed.

Flags:
`

func run(ctx context.Context, args []string, stdout, stderr io.Writer, getenv func(string) string) int {
	fs := flag.NewFlagSet("ionos-export", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var (
		out            = fs.String("o", "", "output file (default ionos-<contract>-<time>.ionx, plus .age when encrypted)")
		force          = fs.Bool("force", false, "overwrite the output file if it exists")
		tokenFile      = fs.String("token-file", "", "read the API token from this file")
		contractNumber = fs.String("contract-number", "", "contract to export, for users with access to several")
		recipientsFile = fs.String("recipients-file", "", "encrypt to the age recipients listed in this file")
		passphraseFile = fs.String("passphrase-file", "", "encrypt with the passphrase read from this file")
		parallel       = fs.Int("parallel", 4, "concurrent requests")
		baseURL        = fs.String("base-url", "", "send all requests to this URL instead of the IONOS API hosts (for a local mock)")
		list           = fs.Bool("list", false, "print every request the exporter can make, then exit")
		verbose        = fs.Bool("v", false, "print every request as it finishes")
		showVersion    = fs.Bool("version", false, "print the version and exit")
		recipients     multiFlag
		skip           multiFlag
	)
	fs.Var(&recipients, "recipient", "encrypt to this age recipient (age1...), repeatable")
	fs.Var(&skip, "skip", "don't fetch this endpoint, path prefix (/um) or API id, repeatable")
	fs.Usage = func() {
		fmt.Fprint(stderr, usage)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return exitFailed
	}
	fail := func(format string, a ...any) int {
		fmt.Fprintf(stderr, "ionos-export: "+format+"\n", a...)
		return exitFailed
	}
	if fs.NArg() > 0 {
		// Not echoed: it might be a token pasted in the wrong place.
		return fail("unexpected argument; credentials go in IONOS_TOKEN or --token-file, never on the command line")
	}
	if *showVersion {
		fmt.Fprintln(stdout, "ionos-export", buildVersion())
		return 0
	}

	bases, hosts, err := endpoints.Bases(*baseURL)
	if err != nil {
		return fail("%v", err)
	}
	if *list {
		printPlan(stdout, bases, hosts)
		return 0
	}

	creds, err := credentials(*tokenFile, getenv)
	if err != nil {
		return fail("%v", err)
	}
	rcps, err := snapshot.Recipients(recipients, *recipientsFile, *passphraseFile)
	if err != nil {
		return fail("%v", err)
	}
	if *out != "" && !*force {
		if _, err := os.Stat(*out); err == nil {
			return fail("%s exists (use --force to overwrite)", *out)
		}
	}

	client := httpx.New(httpx.Options{
		Credentials:    creds,
		Hosts:          hosts,
		UserAgent:      "ionos-export/" + buildVersion(),
		ContractNumber: *contractNumber,
	})
	fmt.Fprintf(stderr, "Exporting from %s with %s…\n", strings.Join(hosts, ", "), creds)
	start := time.Now()
	res, err := export.Run(ctx, export.Config{
		Client:   client,
		BaseURLs: bases,
		Skip:     skip,
		Parallel: *parallel,
		Version:  buildVersion(),
		Progress: func(c snapshot.Coverage) {
			// Problems are listed in the summary; -v shows everything live.
			if *verbose {
				fmt.Fprintln(stderr, " ", line(c))
			}
		},
	})
	if err != nil {
		return fail("%v", err)
	}

	var buf bytes.Buffer
	if err := res.Writer.WriteTo(&buf, snapshot.Options{Recipients: rcps}); err != nil {
		return fail("%v", err)
	}
	path := *out
	if path == "" {
		path = defaultName(res.Manifest, len(rcps) > 0)
	}
	if err := writeFile(path, buf.Bytes(), *force); err != nil {
		return fail("%v", err)
	}

	summary(stderr, res.Manifest, time.Since(start))
	enc := ""
	if len(rcps) > 0 {
		enc = ", encrypted"
	}
	fmt.Fprintf(stderr, "Wrote %s (%s%s).\n", path, size(buf.Len()), enc)
	if res.Partial() {
		fmt.Fprintln(stderr, "The snapshot is partial: some endpoints could not be read (see above).")
		return exitPartial
	}
	return 0
}

func credentials(tokenFile string, getenv func(string) string) (httpx.Credentials, error) {
	var c httpx.Credentials
	switch {
	case tokenFile != "":
		b, err := os.ReadFile(tokenFile)
		if err != nil {
			return c, err
		}
		c.Token = strings.TrimSpace(string(b))
		if c.Token == "" {
			return c, fmt.Errorf("%s is empty", tokenFile)
		}
	case getenv("IONOS_TOKEN") != "":
		c.Token = strings.TrimSpace(getenv("IONOS_TOKEN"))
	case getenv("IONOS_USERNAME") != "":
		c.Username, c.Password = getenv("IONOS_USERNAME"), getenv("IONOS_PASSWORD")
		if c.Password == "" {
			return c, errors.New("IONOS_USERNAME is set but IONOS_PASSWORD is not")
		}
	default:
		return c, errors.New("no credentials: set IONOS_TOKEN, use --token-file, or set IONOS_USERNAME and IONOS_PASSWORD")
	}
	return c, nil
}

func printPlan(w io.Writer, bases map[string]string, hosts []string) {
	fmt.Fprintf(w, "ionos-export sends only GET requests, only to %s.\n", strings.Join(hosts, ", "))
	fmt.Fprintln(w, "{param} paths are requested once per item of the parent collection.")
	for _, a := range endpoints.APIs {
		fmt.Fprintf(w, "\n%s (%s %s)\n", bases[a.ID], a.Name, a.Version)
		for _, ep := range endpoints.Plan {
			if ep.API != a.ID {
				continue
			}
			p := ep.Path
			if ep.Query != "" {
				p += "?" + ep.Query
			}
			fmt.Fprintf(w, "  GET %-66s %s\n", p, ep.About)
		}
	}
}

func line(c snapshot.Coverage) string {
	s := fmt.Sprintf("%-9s %s %s", c.Status, c.API, c.Path)
	if c.Items != nil {
		s += " (" + plural(*c.Items, "item")
		if c.Pages > 1 {
			s += fmt.Sprintf(", %d pages", c.Pages)
		}
		s += ")"
	}
	if c.Error != "" {
		s += ": " + c.Error
	}
	return s
}

func summary(w io.Writer, m snapshot.Manifest, took time.Duration) {
	counts := map[string]int{}
	type issue struct{ endpoint, status, err string }
	issues := map[issue]int{}
	dcs := 0
	for _, c := range m.Coverage {
		counts[c.Status]++
		if c.Status != snapshot.StatusOK {
			issues[issue{c.API + " " + c.Endpoint, c.Status, c.Error}]++
		}
		if c.Endpoint == "/datacenters" && c.Items != nil {
			dcs = *c.Items
		}
	}
	var parts []string
	for _, s := range []string{snapshot.StatusOK, snapshot.StatusForbidden, snapshot.StatusNotFound, snapshot.StatusError, snapshot.StatusSkipped} {
		if counts[s] > 0 {
			parts = append(parts, fmt.Sprintf("%d %s", counts[s], s))
		}
	}
	contract := ""
	if m.Contract != nil {
		contract = fmt.Sprintf("Contract %d, ", m.Contract.Number)
	}
	fmt.Fprintf(w, "%s%d datacenters, %d collections in %s: %s.\n", contract, dcs, len(m.Coverage), took.Round(100*time.Millisecond), strings.Join(parts, ", "))
	keys := make([]issue, 0, len(issues))
	for k := range issues {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i].endpoint+keys[i].status < keys[j].endpoint+keys[j].status })
	for _, k := range keys {
		n := ""
		if issues[k] > 1 {
			n = fmt.Sprintf(" ×%d", issues[k])
		}
		fmt.Fprintf(w, "  %-9s %s%s: %s\n", k.status, k.endpoint, n, k.err)
	}
}

func defaultName(m snapshot.Manifest, encrypted bool) string {
	name := "ionos"
	if m.Contract != nil {
		name += fmt.Sprintf("-%d", m.Contract.Number)
	}
	name += "-" + m.CreatedAt.UTC().Format("20060102T150405Z") + ".ionx"
	if encrypted {
		name += ".age"
	}
	return name
}

// writeFile writes atomically, readable only by the owner: snapshots are
// confidential.
func writeFile(path string, data []byte, force bool) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".ionos-export-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if !force {
		if _, err := os.Stat(path); err == nil {
			return fmt.Errorf("%s exists (use --force to overwrite)", path)
		}
	}
	return os.Rename(tmp.Name(), path)
}

func plural(n int, word string) string {
	if n == 1 {
		return "1 " + word
	}
	return fmt.Sprintf("%d %ss", n, word)
}

func size(n int) string {
	if n < 1<<20 {
		return fmt.Sprintf("%.0f KB", float64(n)/1024)
	}
	return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
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
