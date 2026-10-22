package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"filippo.io/age"

	"github.com/K4ugummi/ionos-explorer/exporter/internal/history"
	"github.com/K4ugummi/ionos-explorer/exporter/internal/users"
)

func TestKeygenAndRekey(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := runKeygen(nil, &out, &errOut); code != 0 {
		t.Fatal(errOut.String())
	}
	newIDs, err := history.ParseIdentities(out.String())
	if err != nil || len(newIDs) != 1 || !strings.Contains(out.String(), "# public key: "+newIDs[0].Recipient().String()) {
		t.Fatalf("keygen printed %q: %v", out.String(), err)
	}

	// A history under an old key.
	dir := t.TempDir()
	oldID, _ := age.GenerateX25519Identity()
	hs, err := history.Open(dir, []*age.X25519Identity{oldID}, history.Options{})
	if err != nil {
		t.Fatal(err)
	}
	e, err := hs.Put("local:u1", []byte("snapshot"), history.Meta{CreatedAt: time.Now(), Contract: 7})
	if err != nil {
		t.Fatal(err)
	}
	// And an account with a second factor under the old key.
	us, err := users.Open(dir, users.Options{Params: usersOptions.Params, Identities: []*age.X25519Identity{oldID}})
	if err != nil {
		t.Fatal(err)
	}
	u, err := us.AddWithPassword(context.Background(), "alice", "", users.RoleUser, password, false, false)
	if err != nil {
		t.Fatal(err)
	}
	secret := users.NewTOTPSecret()
	if _, _, err := us.EnableTOTP(context.Background(), u.ID, password, secret, users.TOTP(secret, time.Now())); err != nil {
		t.Fatal(err)
	}
	keys := filepath.Join(t.TempDir(), "keys")
	if err := os.WriteFile(keys, []byte(out.String()+"# old\n"+oldID.String()+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("IONOS_EXPLORER_DATA_DIR", dir)
	t.Setenv("IONOS_EXPLORER_AGE_IDENTITY_FILE", keys)
	out.Reset()
	if code := runRekey(nil, &out, &errOut); code != 0 || !strings.Contains(out.String(), "2 files") || !strings.Contains(out.String(), "1 second-factor secrets") {
		t.Fatalf("rekey: %d %s %s", code, out.String(), errOut.String())
	}
	only, err := history.Open(dir, newIDs, history.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if got, err := only.Get("local:u1", e.ID); err != nil || string(got) != "snapshot" {
		t.Fatalf("new key alone: %q %v", got, err)
	}

	newUsers, err := users.Open(dir, users.Options{Params: usersOptions.Params, Identities: newIDs})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := newUsers.SecondFactor(u.ID, users.TOTP(secret, time.Now().Add(30*time.Second))); err != nil {
		t.Fatalf("second factor with the new key alone: %v", err)
	}

	// The users command removes a second factor without any key.
	if code, out, errOut := usersCmd(t, "", "reset-totp", "alice"); code != 0 || !strings.Contains(out, "Second factor of alice removed") {
		t.Fatalf("reset-totp: %d %s %s", code, out, errOut)
	}
	if code, out, _ := usersCmd(t, "", "list"); code != 0 || strings.Contains(out, "second factor") {
		t.Fatalf("list after reset: %s", out)
	}

	t.Setenv("IONOS_EXPLORER_AGE_IDENTITY_FILE", "")
	if code := runRekey(nil, &out, &errOut); code != 1 || !strings.Contains(errOut.String(), "--age-identity-file is required") {
		t.Fatalf("without keys: %d %s", code, errOut.String())
	}
}

func TestParseBytes(t *testing.T) {
	for in, want := range map[string]int64{"0": 0, "500MB": 500 << 20, "2gb": 2 << 30, " 64 KB ": 64 << 10, "123": 123, "10B": 10} {
		if got, err := parseBytes(in); err != nil || got != want {
			t.Errorf("%q: %d %v", in, got, err)
		}
	}
	for _, in := range []string{"", "MB", "-1MB", "1.5GB", "1TB", "99999999999GB"} {
		if _, err := parseBytes(in); err == nil {
			t.Errorf("%q accepted", in)
		}
	}
}
