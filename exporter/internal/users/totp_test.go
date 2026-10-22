package users

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"filippo.io/age"
)

func TestTOTPVectors(t *testing.T) {
	// RFC 6238, appendix B (SHA-1), the last 6 of the 8 digits.
	secret := []byte("12345678901234567890")
	for unix, want := range map[int64]string{
		59: "287082", 1111111109: "081804", 1111111111: "050471", 1234567890: "005924", 2000000000: "279037", 20000000000: "353130",
	} {
		if got := TOTP(secret, time.Unix(unix, 0)); got != want {
			t.Errorf("%d: %s, want %s", unix, got, want)
		}
	}
	now := time.Unix(1111111111, 0)
	cur := now.Unix() / 30
	for d, ok := range map[int64]bool{-2: false, -1: true, 0: true, 1: true, 2: false} {
		code := hotp(secret, uint64(cur+d))
		if step, got := matchTOTP(secret, code, now, 0); got != ok || ok && step != cur+d {
			t.Errorf("step %+d: %v %d", d, got, step)
		}
	}
	// A step at or before the last one used is refused.
	if _, ok := matchTOTP(secret, hotp(secret, uint64(cur)), now, cur); ok {
		t.Error("replay accepted")
	}
}

func TestTOTPURI(t *testing.T) {
	uri := TOTPURI([]byte("12345678901234567890"), "alice@example.com")
	u, err := url.Parse(uri)
	if err != nil || u.Scheme != "otpauth" || u.Host != "totp" || u.Path != "/IONOS Explorer:alice@example.com" {
		t.Fatalf("%s: %+v %v", uri, u, err)
	}
	q := u.Query()
	if q.Get("secret") != "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" || q.Get("issuer") != "IONOS Explorer" || q.Get("digits") != "6" || q.Get("period") != "30" {
		t.Fatalf("%v", q)
	}
}

func openWithKey(t *testing.T, dir string, clk *clock) *Store {
	t.Helper()
	id, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	s, err := Open(dir, Options{Params: testParams, Now: clk.now, Identities: []*age.X25519Identity{id}})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestTOTPLifecycle(t *testing.T) {
	ctx := context.Background()
	clk := &clock{t: time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)}
	dir := t.TempDir()
	s := openWithKey(t, dir, clk)
	u := addUser(t, s, "alice", RoleUser)
	secret := NewTOTPSecret()

	if _, _, err := s.EnableTOTP(ctx, u.ID, "wrong password", secret, TOTP(secret, clk.now())); err == nil || !IsInput(err) {
		t.Fatalf("wrong password: %v", err)
	}
	if _, _, err := s.EnableTOTP(ctx, u.ID, pw, secret, "000000"); err == nil || !IsInput(err) {
		t.Fatalf("wrong code: %v", err)
	}
	enabled, codes, err := s.EnableTOTP(ctx, u.ID, pw, secret, TOTP(secret, clk.now()))
	if err != nil || len(codes) != 10 || enabled.Epoch != u.Epoch+1 || len(enabled.Recovery) != 10 {
		t.Fatalf("%+v %v %v", enabled, codes, err)
	}
	// The file holds neither the secret nor a recovery code.
	data, _ := os.ReadFile(s.Path())
	if strings.Contains(string(data), TOTPKey(secret)) || strings.Contains(string(data), codes[0]) || !strings.Contains(string(data), `"totp": "age:`) {
		t.Fatalf("users file: %s", data)
	}

	// The password alone no longer clears the failures: the code must be right.
	for range freeFailures {
		if _, err := s.SecondFactor(u.ID, "111111"); !errors.Is(err, ErrCode) && !isWait(err) {
			t.Fatalf("wrong code: %v", err)
		}
		if _, err := s.Login(ctx, "alice", pw); err != nil && !isWait(err) {
			t.Fatal(err)
		}
	}
	if _, err := s.SecondFactor(u.ID, TOTP(secret, clk.now())); !isWait(err) {
		t.Fatalf("after 5 wrong codes and logins in between: %v", err)
	}
	clk.add(time.Hour)

	// The code of now works once; the next step's too.
	code := TOTP(secret, clk.now())
	if got, err := s.SecondFactor(u.ID, code[:3]+" "+code[3:]); err != nil || got.LastLogin == nil {
		t.Fatalf("code: %+v %v", got, err)
	}
	if _, err := s.SecondFactor(u.ID, code); !errors.Is(err, ErrCode) {
		t.Fatalf("replayed: %v", err)
	}
	if _, err := s.SecondFactor(u.ID, TOTP(secret, clk.now().Add(30*time.Second))); err != nil {
		t.Fatalf("next step: %v", err)
	}

	// Recovery codes: any case, dashes or not, once each.
	if _, err := s.SecondFactor(u.ID, strings.ToUpper(strings.ReplaceAll(codes[3], "-", ""))); err != nil {
		t.Fatalf("recovery: %v", err)
	}
	if _, err := s.SecondFactor(u.ID, codes[3]); !errors.Is(err, ErrCode) {
		t.Fatalf("recovery code twice: %v", err)
	}
	if got, _ := s.Get(u.ID); len(got.Recovery) != 9 {
		t.Fatalf("recovery left: %d", len(got.Recovery))
	}
	_, fresh, err := s.NewRecoveryCodes(ctx, u.ID, pw)
	if err != nil || len(fresh) != 10 {
		t.Fatal(fresh, err)
	}
	if _, err := s.SecondFactor(u.ID, codes[4]); !errors.Is(err, ErrCode) {
		t.Fatal("old recovery codes still work")
	}

	// Another store with the same key (a restart) reads the secret.
	again, err := Open(dir, Options{Params: testParams, Now: clk.now, Identities: s.ids})
	if err != nil {
		t.Fatal(err)
	}
	clk.add(time.Minute)
	if _, err := again.SecondFactor(u.ID, TOTP(secret, clk.now())); err != nil {
		t.Fatalf("after restart: %v", err)
	}
	// Without the key: no login, an error for the operator, not "wrong code".
	nokey, _ := Open(dir, Options{Params: testParams, Now: clk.now})
	if !nokey.HasTOTP() {
		t.Error("HasTOTP")
	}
	if _, err := nokey.SecondFactor(u.ID, "123456"); !errors.Is(err, ErrNoKey) {
		t.Fatalf("without key: %v", err)
	}

	if _, err := s.DisableTOTP(ctx, u.ID, "wrong password"); err == nil {
		t.Fatal("disabled with a wrong password")
	}
	off, err := s.DisableTOTP(ctx, u.ID, pw)
	if err != nil || off.TOTP != "" || off.Recovery != nil || off.Epoch <= enabled.Epoch {
		t.Fatalf("%+v %v", off, err)
	}
	if _, err := s.SecondFactor(u.ID, TOTP(secret, clk.now())); !errors.Is(err, ErrInvalid) {
		t.Fatalf("after disable: %v", err)
	}
}

func isWait(err error) bool {
	var w *WaitError
	return errors.As(err, &w)
}

func TestTOTPNeedsKeyAndRekey(t *testing.T) {
	ctx := context.Background()
	clk := &clock{t: time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)}
	dir := t.TempDir()
	plain := open(t, dir, clk)
	u := addUser(t, plain, "bob", RoleUser)
	secret := NewTOTPSecret()
	if _, _, err := plain.EnableTOTP(ctx, u.ID, pw, secret, TOTP(secret, clk.now())); !errors.Is(err, ErrNoKey) {
		t.Fatalf("without key: %v", err)
	}

	oldKey := openWithKey(t, dir, clk)
	if _, _, err := oldKey.EnableTOTP(ctx, u.ID, pw, secret, TOTP(secret, clk.now())); err != nil {
		t.Fatal(err)
	}
	newID, _ := age.GenerateX25519Identity()
	both, _ := Open(dir, Options{Params: testParams, Now: clk.now, Identities: []*age.X25519Identity{newID, oldKey.ids[0]}})
	if n, err := both.RekeyTOTP(); err != nil || n != 1 {
		t.Fatalf("rekey: %d %v", n, err)
	}
	if n, _ := both.RekeyTOTP(); n != 0 {
		t.Fatal("rekey twice")
	}
	onlyNew, _ := Open(dir, Options{Params: testParams, Now: clk.now, Identities: []*age.X25519Identity{newID}})
	clk.add(time.Minute)
	if _, err := onlyNew.SecondFactor(u.ID, TOTP(secret, clk.now())); err != nil {
		t.Fatalf("new key alone: %v", err)
	}
	if _, err := onlyNew.ResetTOTP(u.ID); err != nil {
		t.Fatal(err)
	}
	if onlyNew.HasTOTP() {
		t.Fatal("reset left a second factor")
	}
}
