package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"filippo.io/age"

	"github.com/K4ugummi/ionos-explorer/exporter/internal/history"
)

// openHistory opens the snapshot history of hosted mode; nil without
// identities (no history).
func openHistory(dataDir string, ids []*age.X25519Identity, keep, maxUser string) (*history.Store, error) {
	k, err := history.ParseKeep(keep)
	if err != nil {
		return nil, fmt.Errorf("--keep: %v", err)
	}
	quota, err := parseBytes(maxUser)
	if err != nil {
		return nil, fmt.Errorf("--max-user-bytes: %v", err)
	}
	if ids == nil {
		return nil, nil
	}
	if st, err := os.Stat(dataDir); err != nil || !st.IsDir() {
		return nil, fmt.Errorf("data directory %s: not found (create it, or set --data-dir / IONOS_EXPLORER_DATA_DIR)", dataDir)
	}
	hs, err := history.Open(dataDir, ids, history.Options{Keep: k, MaxBytes: quota})
	if errors.Is(err, fs.ErrPermission) {
		return nil, fmt.Errorf("%v: the data directory must be writable for this program's user (uid %d, gid %d); "+
			"give it to that user (chown) or, in Kubernetes, set securityContext.fsGroup", err, os.Getuid(), os.Getgid())
	}
	return hs, err
}

func readIdentities(file string) ([]*age.X25519Identity, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, fmt.Errorf("age identity file: %v", err)
	}
	defer clear(data)
	ids, err := history.ParseIdentities(string(data))
	if err != nil {
		return nil, fmt.Errorf("%s: %v", file, err)
	}
	return ids, nil
}

// parseBytes reads a size: bytes, or with KB, MB, GB (powers of 1024).
func parseBytes(v string) (int64, error) {
	s := strings.ToUpper(strings.TrimSpace(v))
	mult := int64(1)
	for _, u := range []struct {
		suffix string
		mult   int64
	}{{"GB", 1 << 30}, {"MB", 1 << 20}, {"KB", 1 << 10}, {"B", 1}} {
		if rest, ok := strings.CutSuffix(s, u.suffix); ok {
			s, mult = strings.TrimSpace(rest), u.mult
			break
		}
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n < 0 || n > (1<<62)/mult {
		return 0, fmt.Errorf("%q: a size such as 500MB, 2GB or 0 (no limit)", v)
	}
	return n * mult, nil
}

const keygenUsage = `Usage: ionos-explorer keygen > age-identity.txt

Prints a new age identity (X25519) for the snapshot history of hosted mode,
with its public key as a comment. Keep it like a password, as a Docker or
Kubernetes secret, and give the server its file with --age-identity-file
(IONOS_EXPLORER_AGE_IDENTITY_FILE). Without it the history cannot be read:
keep a copy where you keep your other secrets.
`

func runKeygen(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("ionos-explorer keygen", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { fmt.Fprint(stderr, keygenUsage) }
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 1
	}
	if fs.NArg() > 0 {
		fs.Usage()
		return 1
	}
	id, err := age.GenerateX25519Identity()
	if err != nil {
		fmt.Fprintf(stderr, "ionos-explorer keygen: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "# created: %s\n# public key: %s\n%s\n", time.Now().UTC().Format(time.RFC3339), id.Recipient(), id)
	return 0
}

const rekeyUsage = `Usage: ionos-explorer rekey [flags]

Encrypts every snapshot of the history, and every second-factor secret of
the user accounts, that the first identity in the identity file cannot read
to it. To move to a new key: put the new identity
first in the file (the old one after it), restart the server, run rekey,
then remove the old identity and restart again. Files no identity in the
file can read are reported and left as they are.

Flags (also from IONOS_EXPLORER_DATA_DIR, IONOS_EXPLORER_AGE_IDENTITY_FILE):
`

func runRekey(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("ionos-explorer rekey", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var (
		dataDir = fs.String("data-dir", "/data", "the server's data directory")
		idFile  = fs.String("age-identity-file", "", "the server's age identities, the new one first")
	)
	fs.Usage = func() {
		fmt.Fprint(stderr, rekeyUsage)
		fs.PrintDefaults()
	}
	fail := func(format string, a ...any) int {
		fmt.Fprintf(stderr, "ionos-explorer rekey: "+format+"\n", a...)
		return 1
	}
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 1
	}
	if fs.NArg() > 0 {
		return fail("unexpected argument")
	}
	if _, err := fromEnv(fs, map[string]bool{"data-dir": true, "age-identity-file": true}); err != nil {
		return fail("%v", err)
	}
	if *idFile == "" {
		return fail("--age-identity-file is required")
	}
	ids, err := readIdentities(*idFile)
	if err != nil {
		return fail("%v", err)
	}
	hs, err := openHistory(*dataDir, ids, history.DefaultKeep.String(), "0")
	if err != nil {
		return fail("%v", err)
	}
	n, err := hs.Rekey()
	fmt.Fprintf(stdout, "%d files encrypted to the first identity.\n", n)
	if err != nil {
		return fail("%v", err)
	}
	if _, err := os.Stat(filepath.Join(*dataDir, "v1", "users.json")); err == nil {
		store, err := openUsers(*dataDir, ids)
		if err != nil {
			return fail("%v", err)
		}
		n, err := store.RekeyTOTP()
		fmt.Fprintf(stdout, "%d second-factor secrets encrypted to the first identity.\n", n)
		if err != nil {
			return fail("%v", err)
		}
	}
	return 0
}
