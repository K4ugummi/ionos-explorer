// Command ionos-fakeapi serves the synthetic demo contract the way the IONOS
// API would, for trying ionos-explorer and testing deployments without an
// IONOS account: point ionos-explorer at it with --base-url. It holds no
// real data and accepts one fixed token. For development and CI only; the
// release image does not contain it.
//
// ionos-explorer sends a token over plain http only to a loopback address,
// so the fake has to listen on the explorer's loopback: in Compose
// network_mode "service:explorer", in Kubernetes a container in the same
// pod.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/K4ugummi/ionos-explorer/exporter/internal/fakeapi"
)

var version = "dev"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := run(ctx, os.Args[1:], os.Stderr)
	stop()
	os.Exit(code)
}

func run(ctx context.Context, args []string, stderr io.Writer) int {
	fs := flag.NewFlagSet("ionos-fakeapi", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var (
		listen      = fs.String("listen", "127.0.0.1:8792", "address to listen on")
		token       = fs.String("token", "demo-token", "the API token it accepts (a fake one: this serves synthetic data)")
		pageSize    = fs.Int("page-size", 50, "items per page of a paged collection")
		showVersion = fs.Bool("version", false, "print the version and exit")
	)
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 1
	}
	if *showVersion {
		fmt.Fprintln(stderr, "ionos-fakeapi", version)
		return 0
	}
	logger := log.New(stderr, "ionos-fakeapi: ", log.LstdFlags)
	demo, err := fakeapi.Demo()
	if err != nil {
		logger.Print(err)
		return 1
	}
	api := &fakeapi.Server{Snap: demo, Token: *token, PageSize: *pageSize, Errorf: logger.Printf}
	hs := &http.Server{Addr: *listen, Handler: api, ReadHeaderTimeout: 10 * time.Second}
	served := make(chan error, 1)
	go func() { served <- hs.ListenAndServe() }()
	logger.Printf("serving the synthetic demo contract on %s (token %q)", *listen, *token)
	select {
	case err := <-served:
		logger.Print(err)
		return 1
	case <-ctx.Done():
	}
	shut, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = hs.Shutdown(shut)
	logger.Printf("stopped after %d requests", api.Requests.Load())
	return 0
}
