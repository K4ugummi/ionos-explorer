package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"filippo.io/age"

	"github.com/K4ugummi/ionos-explorer/exporter/internal/history"
	"github.com/K4ugummi/ionos-explorer/exporter/internal/server"
	"github.com/K4ugummi/ionos-explorer/exporter/internal/users"
)

// stdin is where --password-stdin reads (tests replace it).
var stdin io.Reader = os.Stdin

const usersUsage = `Usage: ionos-explorer users [flags] <command> [arguments]

Manages the local user accounts of hosted mode, in the same data directory
as the server, also while it runs (in a container: docker exec or kubectl
exec). Changes take effect at the user's next request.

Commands:
  list                         the accounts
  add <username>               a new account; prints a one-time link (24 h)
                               to set the password, or reads it with
                               --password-stdin; --name, --role user|admin
  reset <username>             removes the password and ends the sessions;
                               prints a new link (or --password-stdin)
  reset-totp <username>        removes the second factor (a lost phone) and
                               ends the sessions
  disable <username>           ends the sessions; no login until enabled
  enable <username>
  role <username> admin|user
  delete <username>            also deletes their snapshot history

The last enabled admin cannot be disabled, demoted or deleted.

Flags (also from IONOS_EXPLORER_DATA_DIR, IONOS_EXPLORER_PUBLIC_URL):
`

func runUsers(ctx context.Context, args []string, in io.Reader, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("ionos-explorer users", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var (
		dataDir   = fs.String("data-dir", "/data", "the server's data directory")
		publicURL = fs.String("public-url", "", "the server's public URL, to print whole links")
		name      = fs.String("name", "", "add: the name shown")
		role      = fs.String("role", users.RoleUser, "add: user or admin")
		fromStdin = fs.Bool("password-stdin", false, "add, reset: read the password from the first line of stdin instead of printing a link")
	)
	fs.Usage = func() {
		fmt.Fprint(stderr, usersUsage)
		fs.PrintDefaults()
	}
	fail := func(format string, a ...any) int {
		fmt.Fprintf(stderr, "ionos-explorer users: "+format+"\n", a...)
		return 1
	}
	// Flags may come before or after the arguments.
	var pos []string
	for rest := args; ; {
		if err := fs.Parse(rest); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return 0
			}
			return 1
		}
		if fs.NArg() == 0 {
			break
		}
		pos = append(pos, fs.Arg(0))
		rest = fs.Args()[1:]
	}
	if _, err := fromEnv(fs, map[string]bool{"data-dir": true, "public-url": true}); err != nil {
		return fail("%v", err)
	}
	if len(pos) == 0 {
		fs.Usage()
		return 1
	}
	want := map[string]int{"list": 1, "add": 2, "reset": 2, "reset-totp": 2, "disable": 2, "enable": 2, "delete": 2, "role": 3}[pos[0]]
	if want == 0 {
		return fail("unknown command %q (list, add, reset, reset-totp, disable, enable, role, delete)", pos[0])
	}
	if len(pos) != want {
		return fail("%s: wrong number of arguments; see ionos-explorer users -h", pos[0])
	}
	link := func(code string) string { return "<public URL>/#link=" + code }
	if *publicURL != "" {
		p, err := server.ParsePublicURL(*publicURL)
		if err != nil {
			return fail("%v", err)
		}
		link = p.LinkURL
	}
	store, err := openUsers(*dataDir, nil)
	if err != nil {
		return fail("%v", err)
	}
	if pos[0] == "list" {
		return listUsers(store, stdout, stderr)
	}
	u, found := store.Find(pos[1])
	if pos[0] != "add" && !found {
		return fail("%s: no such user", pos[1])
	}
	password := ""
	if *fromStdin {
		if pos[0] != "add" && pos[0] != "reset" {
			return fail("--password-stdin is for add and reset")
		}
		line, err := bufio.NewReader(io.LimitReader(in, 4<<10)).ReadString('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return fail("reading the password: %v", err)
		}
		password = strings.TrimRight(line, "\r\n")
		if err := users.CheckPassword(users.NormalizeUsername(pos[1]), password); err != nil {
			return fail("%v", err)
		}
	}
	switch pos[0] {
	case "add":
		if *fromStdin {
			u, err = store.AddWithPassword(ctx, pos[1], *name, *role, password, false, false)
			if err == nil {
				fmt.Fprintf(stdout, "Added %s (%s).\n", u.Username, u.Role)
			}
			break
		}
		var code string
		if u, code, err = store.Add(pos[1], *name, *role); err == nil {
			fmt.Fprintf(stdout, "Added %s (%s). Pass on this link to set the password (once, within %s):\n\n  %s\n", u.Username, u.Role, users.LinkTTL, link(code))
		}
	case "reset":
		if *fromStdin {
			if _, err = store.SetPassword(ctx, u.ID, password); err == nil {
				fmt.Fprintf(stdout, "Password of %s set; their sessions end.\n", u.Username)
			}
			break
		}
		var code string
		if code, err = store.Reset(u.ID); err == nil {
			fmt.Fprintf(stdout, "Password of %s removed; their sessions end. Pass on this link to set a new one (once, within %s):\n\n  %s\n", u.Username, users.LinkTTL, link(code))
		}
	case "reset-totp":
		if _, err = store.ResetTOTP(u.ID); err == nil {
			fmt.Fprintf(stdout, "Second factor of %s removed; their sessions end. They can set up a new one after logging in.\n", u.Username)
		}
	case "disable", "enable":
		if _, err = store.SetDisabled(u.ID, pos[0] == "disable"); err == nil {
			fmt.Fprintf(stdout, "%s %sd.\n", u.Username, pos[0])
		}
	case "role":
		if _, err = store.SetRole(u.ID, pos[2]); err == nil {
			fmt.Fprintf(stdout, "%s is now %s.\n", u.Username, pos[2])
		}
	case "delete":
		if err = store.Delete(u.ID); err == nil {
			fmt.Fprintf(stdout, "%s deleted.\n", u.Username)
			if herr := history.RemoveScope(*dataDir, "local:"+u.ID); herr != nil {
				fmt.Fprintf(stderr, "ionos-explorer users: their snapshot history could not be removed: %v\n", herr)
			}
		}
	}
	if err != nil {
		return fail("%v", err)
	}
	return 0
}

func listUsers(store *users.Store, stdout, stderr io.Writer) int {
	all, err := store.Users()
	if err != nil {
		fmt.Fprintf(stderr, "ionos-explorer users: %v\n", err)
		return 1
	}
	tw := tabwriter.NewWriter(stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "USERNAME\tNAME\tROLE\tSTATE\tLAST LOGIN")
	for _, u := range all {
		var state []string
		switch {
		case u.Disabled:
			state = append(state, "disabled")
		case store.Locked(u.Username):
			state = append(state, "delayed after failed logins")
		default:
			state = append(state, "enabled")
		}
		if u.Hash == "" {
			state = append(state, "no password yet")
		} else if u.MustChange {
			state = append(state, "must change password")
		}
		if u.TOTP != "" {
			state = append(state, "second factor")
		}
		last := "never"
		if u.LastLogin != nil {
			last = u.LastLogin.Local().Format(time.DateTime)
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", u.Username, u.Name, u.Role, strings.Join(state, ", "), last)
	}
	_ = tw.Flush()
	if len(all) == 0 {
		fmt.Fprintln(stdout, "No accounts yet: the server logs a link to create the first admin.")
	}
	return 0
}

// openUsers opens the users store in an existing data directory.
// With ids it can keep second factors.
func openUsers(dataDir string, ids []*age.X25519Identity) (*users.Store, error) {
	if st, err := os.Stat(dataDir); err != nil || !st.IsDir() {
		return nil, fmt.Errorf("data directory %s: not found (create it, or set --data-dir / IONOS_EXPLORER_DATA_DIR)", dataDir)
	}
	opts := usersOptions
	opts.Identities = ids
	store, err := users.Open(dataDir, opts)
	if errors.Is(err, fs.ErrPermission) {
		return nil, fmt.Errorf("%v: the data directory must be writable for this program's user (uid %d, gid %d); "+
			"give it to that user (chown) or, in Kubernetes, set securityContext.fsGroup", err, os.Getuid(), os.Getgid())
	}
	return store, err
}

// firstAdmin creates the first admin with the password in a file (a Docker
// or Kubernetes secret) when there are no users yet; it must be changed at
// the first login.
func firstAdmin(ctx context.Context, store *users.Store, username, file string, logger *server.Logger) error {
	data, err := os.ReadFile(file)
	if err != nil {
		return fmt.Errorf("admin password file: %v", err)
	}
	defer clear(data)
	password := strings.TrimRight(string(data), "\r\n")
	_, err = store.AddWithPassword(ctx, username, "", users.RoleAdmin, password, true, true)
	switch {
	case errors.Is(err, users.ErrNotEmpty):
		return nil // done before; the file is not needed any more
	case err != nil:
		return fmt.Errorf("first admin from %s: %v", file, err)
	}
	logger.Print(fmt.Sprintf("First admin %q created from the admin password file; the password must be changed at the first login.", users.NormalizeUsername(username)))
	return nil
}
