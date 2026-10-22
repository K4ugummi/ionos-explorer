package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

const healthcheckUsage = `Usage: ionos-explorer healthcheck [flags]

Asks the server in this container whether it is alive (/healthz) or, with
--ready, whether it can serve users (/readyz). Exit status 0 if so, 1 if
not. For Docker's HEALTHCHECK: the image has no curl or wget.

Flags (also from IONOS_EXPLORER_LISTEN):
`

func runHealthcheck(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("ionos-explorer healthcheck", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var (
		listen  = fs.String("listen", ":8080", "the server's listen address")
		ready   = fs.Bool("ready", false, "ask /readyz instead of /healthz")
		timeout = fs.Duration("timeout", 3*time.Second, "give up after this long")
	)
	fs.Usage = func() {
		fmt.Fprint(stderr, healthcheckUsage)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 1
	}
	fail := func(format string, a ...any) int {
		fmt.Fprintf(stderr, "ionos-explorer healthcheck: "+format+"\n", a...)
		return 1
	}
	if fs.NArg() > 0 {
		return fail("unexpected argument")
	}
	if _, err := fromEnv(fs, map[string]bool{"listen": true}); err != nil {
		return fail("%v", err)
	}
	target, err := probeURL(*listen, *ready)
	if err != nil {
		return fail("%v", err)
	}
	ctx, cancel := context.WithTimeout(ctx, *timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return fail("%v", err)
	}
	// Straight to this machine: no proxy from the environment.
	client := &http.Client{Transport: &http.Transport{Proxy: nil}}
	resp, err := client.Do(req)
	if err != nil {
		return fail("%v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	text := strings.TrimSpace(string(body))
	if resp.StatusCode != http.StatusOK {
		return fail("%s: %d %s", target, resp.StatusCode, text)
	}
	fmt.Fprintln(stdout, text)
	return 0
}

// probeURL is the probe on the server's listen address; a wildcard address
// is asked on loopback.
func probeURL(listen string, ready bool) (string, error) {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return "", fmt.Errorf("--listen %s: %v", listen, err)
	}
	if port == "" || port == "0" {
		return "", fmt.Errorf("--listen %s: need the port", listen)
	}
	if ip := net.ParseIP(host); host == "" || ip != nil && ip.IsUnspecified() {
		host = "127.0.0.1"
	}
	path := "/healthz"
	if ready {
		path = "/readyz"
	}
	return "http://" + net.JoinHostPort(host, port) + path, nil
}
