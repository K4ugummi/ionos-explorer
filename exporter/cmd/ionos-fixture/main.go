// Command ionos-fixture writes a synthetic IONOS snapshot (.ionx) for
// developing and testing the explorer without access to a real contract.
package main

import (
	"bytes"
	"flag"
	"fmt"
	"os"
	"strings"

	"filippo.io/age"

	"ionos-explorer/exporter/internal/fixture"
	"ionos-explorer/exporter/internal/snapshot"
)

var version = "dev"

type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "ionos-fixture:", err)
		os.Exit(1)
	}
}

func run() error {
	var (
		out            = flag.String("o", "demo-contract.ionx", "output file")
		seed           = flag.Int64("seed", 1, "random seed (same seed = identical output)")
		passphraseFile = flag.String("passphrase-file", "", "encrypt with the passphrase read from this file")
		recipients     multiFlag
	)
	flag.Var(&recipients, "recipient", "encrypt to this age X25519 recipient (age1...), repeatable")
	flag.Parse()

	var opts snapshot.Options
	for _, r := range recipients {
		rcp, err := age.ParseX25519Recipient(r)
		if err != nil {
			return fmt.Errorf("--recipient %q: %w", r, err)
		}
		opts.Recipients = append(opts.Recipients, rcp)
	}
	if *passphraseFile != "" {
		if len(recipients) > 0 {
			// age does not allow mixing scrypt with other recipients.
			return fmt.Errorf("--passphrase-file cannot be combined with --recipient")
		}
		b, err := os.ReadFile(*passphraseFile)
		if err != nil {
			return err
		}
		rcp, err := age.NewScryptRecipient(strings.TrimRight(string(b), "\r\n"))
		if err != nil {
			return err
		}
		opts.Recipients = append(opts.Recipients, rcp)
	}

	w, err := fixture.Generate(fixture.Options{Seed: *seed, Version: version})
	if err != nil {
		return err
	}
	var buf bytes.Buffer
	if err := w.WriteTo(&buf, opts); err != nil {
		return err
	}
	if err := os.WriteFile(*out, buf.Bytes(), 0o600); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "wrote %s (%d bytes)\n", *out, buf.Len())
	return nil
}
