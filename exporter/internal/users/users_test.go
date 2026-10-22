package users

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Cheap parameters: the tests hash a lot.
var testParams = Params{Memory: 64, Time: 1, Threads: 1}

const pw = "correct horse battery"

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time      { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) { c.mu.Lock(); defer c.mu.Unlock(); c.t = c.t.Add(d) }

func open(t *testing.T, dir string, clk *clock) *Store {
	t.Helper()
	opts := Options{Params: testParams}
	if clk != nil {
		opts.Now = clk.now
	}
	s, err := Open(dir, opts)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func addUser(t *testing.T, s *Store, name, role string) User {
	t.Helper()
	u, err := s.AddWithPassword(context.Background(), name, "", role, pw, false, false)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func TestHash(t *testing.T) {
	h := hash(pw, testParams)
	if !strings.HasPrefix(h, "$argon2id$v=19$m=64,t=1,p=1$") || h == hash(pw, testParams) {
		t.Fatal(h)
	}
	if ok, stale, err := verify(pw, h, testParams); !ok || stale || err != nil {
		t.Error("round trip", ok, stale, err)
	}
	if ok, _, _ := verify(pw+"x", h, testParams); ok {
		t.Error("wrong password accepted")
	}
	if ok, stale, _ := verify(pw, h, Params{Memory: 128, Time: 1, Threads: 1}); !ok || !stale {
		t.Error("other parameters: still valid, but stale")
	}
	if _, _, err := verify(pw, hash(pw, DefaultParams), DefaultParams); err != nil {
		t.Error(err)
	}
	for _, bad := range []string{"", "$argon2i$v=19$m=64,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA", "$argon2id$v=18$m=64,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA",
		"$argon2id$v=19$m=999999999,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA", "$argon2id$v=19$m=64,t=1,p=1$!!$aGFzaGhhc2hoYXNoaGFzaA", "plain"} {
		if ok, _, err := verify(pw, bad, testParams); ok || err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestPasswordPolicy(t *testing.T) {
	for password, want := range map[string]string{
		"short":                              "at least 12",
		strings.Repeat("ä", 11):              "at least 12",
		strings.Repeat("x", 257):             "at most 256",
		"Alice.Example1":                     "must not be the username",
		"PasswordPassword":                   "common passwords",
		"123456789012":                       "common passwords",
		"\xff\xfe" + strings.Repeat("a", 12): "not valid text",
		pw:                                   "",
		strings.Repeat("ä", 12):              "",
	} {
		err := CheckPassword("alice.example1", password)
		if want == "" && err != nil || want != "" && (err == nil || !strings.Contains(err.Error(), want)) {
			t.Errorf("%q: %v", password, err)
		}
	}
	if n := len(common()); n < 40000 {
		t.Errorf("%d common passwords", n)
	}
}

func TestUsernames(t *testing.T) {
	for in, want := range map[string]string{" Alice ": "alice", "a.b_c-d@example.com": "a.b_c-d@example.com", "": "", "a b": "", "ä": "", strings.Repeat("a", 65): ""} {
		if got := NormalizeUsername(in); got != want {
			t.Errorf("%q: %q", in, got)
		}
	}
	s := open(t, t.TempDir(), nil)
	addUser(t, s, "Alice", RoleAdmin)
	if _, err := s.AddWithPassword(context.Background(), "ALICE", "", RoleUser, pw, false, false); !errors.Is(err, ErrExists) {
		t.Error("usernames are case-insensitive:", err)
	}
	for _, bad := range [][3]string{{"bob", "Bob\n", RoleUser}, {"bob", "Bob", "root"}, {"b b", "", RoleUser}} {
		if _, _, err := s.Add(bad[0], bad[1], bad[2]); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestFile(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, nil)
	if empty, err := s.Empty(); !empty || err != nil {
		t.Fatal(empty, err)
	}
	alice := addUser(t, s, "alice", RoleAdmin)
	st, err := os.Stat(s.Path())
	d, _ := os.Stat(filepath.Dir(s.Path()))
	if err != nil || st.Mode().Perm() != 0o600 || d.Mode().Perm() != 0o700 || s.Path() != filepath.Join(dir, "v1", "users.json") {
		t.Fatalf("%v %v %v", err, st, d)
	}
	data, _ := os.ReadFile(s.Path())
	if strings.Contains(string(data), pw) || !strings.Contains(string(data), "$argon2id$") {
		t.Errorf("file: %s", data)
	}
	// Another process (the users command) changes the file; the server sees it.
	other := open(t, dir, nil)
	if _, err := other.SetDisabled(alice.ID, false); err != nil {
		t.Fatal(err)
	}
	bob := addUser(t, other, "bob", RoleUser)
	if _, ok := s.Get(bob.ID); !ok {
		t.Error("change by another store not seen")
	}
	// Both change at once: nothing is lost.
	var wg sync.WaitGroup
	for i := range 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			st := s
			if i%2 == 1 {
				st = other
			}
			if _, _, err := st.Add("user"+string(rune('a'+i)), "", RoleUser); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if all, _ := s.Users(); len(all) != 12 || all[0].Username != "alice" {
		t.Errorf("%d users", len(all))
	}
	entries, _ := os.ReadDir(filepath.Dir(s.Path()))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Error("temporary file left:", e.Name())
		}
	}

	// A broken file is reported, kept, and not overwritten.
	before, _ := os.ReadFile(s.Path())
	broken := append([]byte(nil), before[:len(before)/2]...)
	if err := os.WriteFile(s.Path(), broken, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Users(); err == nil {
		t.Error("broken file read without error")
	}
	if _, ok := s.Get(bob.ID); !ok {
		t.Error("the last good state is gone")
	}
	if _, _, err := s.Add("carol", "", RoleUser); err == nil {
		t.Error("changed a broken file")
	}
	if after, _ := os.ReadFile(s.Path()); string(after) != string(broken) {
		t.Error("the broken file was overwritten")
	}
	if _, err := Open(dir, Options{Params: testParams}); err == nil {
		t.Error("opened a broken file")
	}
	for name, content := range map[string]string{
		"unknown field": `{"version":1,"users":[],"extra":1}`,
		"version 2":     `{"version":2,"users":[]}`,
		"bad role":      `{"version":1,"users":[{"id":"u1","username":"a","role":"root","created":"2026-01-01T00:00:00Z","sessionEpoch":0}]}`,
		"same name":     `{"version":1,"users":[{"id":"u1","username":"a","role":"user","created":"2026-01-01T00:00:00Z","sessionEpoch":0},{"id":"u2","username":"a","role":"user","created":"2026-01-01T00:00:00Z","sessionEpoch":0}]}`,
		"upper case":    `{"version":1,"users":[{"id":"u1","username":"A","role":"user","created":"2026-01-01T00:00:00Z","sessionEpoch":0}]}`,
	} {
		d := t.TempDir()
		_ = os.MkdirAll(filepath.Join(d, "v1"), 0o700)
		_ = os.WriteFile(filepath.Join(d, "v1", "users.json"), []byte(content), 0o600)
		if _, err := Open(d, Options{Params: testParams}); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	if _, err := Open("", Options{}); err == nil {
		t.Error("no data directory accepted")
	}
}

func TestLogin(t *testing.T) {
	s := open(t, t.TempDir(), nil)
	ctx := context.Background()
	alice := addUser(t, s, "alice", RoleAdmin)
	u, err := s.Login(ctx, " Alice ", pw)
	if err != nil || u.ID != alice.ID || u.LastLogin == nil {
		t.Fatal(u, err)
	}
	pending, _, _ := s.Add("pending", "", RoleUser)
	disabled := addUser(t, s, "disabled", RoleUser)
	if _, err := s.SetDisabled(disabled.ID, true); err != nil {
		t.Fatal(err)
	}
	for name, c := range map[string][2]string{
		"wrong password": {"alice", pw + "x"}, "unknown user": {"nobody", pw}, "no password yet": {pending.Username, ""},
		"disabled": {"disabled", pw}, "empty": {"", ""}, "huge": {"alice", strings.Repeat("x", 2000)},
	} {
		if _, err := s.Login(ctx, c[0], c[1]); err != ErrInvalid {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestLoginTakesAsLongForUnknownUsers(t *testing.T) {
	s, err := Open(t.TempDir(), Options{Params: Params{Memory: 16 << 10, Time: 1, Threads: 1}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddWithPassword(context.Background(), "alice", "", RoleAdmin, pw, false, false); err != nil {
		t.Fatal(err)
	}
	timeIt := func(user string) time.Duration {
		best := time.Hour
		for range 3 {
			start := time.Now()
			_, _ = s.Login(context.Background(), user, "wrong password here")
			best = min(best, time.Since(start))
		}
		return best
	}
	known, unknown := timeIt("alice"), timeIt("nobody")
	if unknown < known/2 || unknown > known*2 {
		t.Errorf("wrong password %s, unknown user %s", known, unknown)
	}
}

func TestDelayAfterFailures(t *testing.T) {
	clk := &clock{t: time.Date(2026, 10, 16, 8, 0, 0, 0, time.UTC)}
	s := open(t, t.TempDir(), clk)
	ctx := context.Background()
	addUser(t, s, "alice", RoleAdmin)
	for range 4 {
		if _, err := s.Login(ctx, "alice", "wrong"); err != ErrInvalid {
			t.Fatal(err)
		}
	}
	if s.Locked("alice") {
		t.Fatal("locked after 4")
	}
	_, _ = s.Login(ctx, "alice", "wrong")
	var wait *WaitError
	if _, err := s.Login(ctx, "alice", pw); !errors.As(err, &wait) || wait.Retry != time.Second || !s.Locked("alice") {
		t.Fatalf("right password inside the delay: %v", err)
	}
	if !strings.Contains(wait.Error(), "try again in 1s") {
		t.Error(wait.Error())
	}
	if _, err := s.Login(ctx, "bob", "wrong"); err != ErrInvalid {
		t.Error("another username is not delayed:", err)
	}
	clk.add(time.Second)
	_, _ = s.Login(ctx, "alice", "wrong")
	if _, err := s.Login(ctx, "alice", pw); !errors.As(err, &wait) || wait.Retry != 2*time.Second {
		t.Fatalf("second delay: %v", err)
	}
	for range 20 {
		clk.add(maxDelay)
		_, _ = s.Login(ctx, "alice", "wrong")
	}
	if _, err := s.Login(ctx, "alice", pw); !errors.As(err, &wait) || wait.Retry != maxDelay {
		t.Fatalf("capped delay: %v", err)
	}
	clk.add(maxDelay)
	if _, err := s.Login(ctx, "alice", pw); err != nil {
		t.Fatal("after the delay:", err)
	}
	if _, err := s.Login(ctx, "alice", "wrong"); err != ErrInvalid {
		t.Error("the count starts over after a login:", err)
	}
	// Unknown usernames are delayed the same way (no telling them apart).
	for range 5 {
		_, _ = s.Login(ctx, "nobody", "wrong")
	}
	if _, err := s.Login(ctx, "nobody", "wrong"); !errors.As(err, &wait) {
		t.Error("unknown username not delayed:", err)
	}
}

func TestHashSlots(t *testing.T) {
	s := open(t, t.TempDir(), nil)
	addUser(t, s, "alice", RoleAdmin)
	s.busyWait = 20 * time.Millisecond
	s.hashing <- struct{}{}
	s.hashing <- struct{}{}
	if _, err := s.Login(context.Background(), "alice", pw); err != ErrBusy {
		t.Error("third hash at once:", err)
	}
	<-s.hashing
	if _, err := s.Login(context.Background(), "alice", pw); err != nil {
		t.Error(err)
	}
}

func TestRehashWithNewParameters(t *testing.T) {
	dir := t.TempDir()
	addUser(t, open(t, dir, nil), "alice", RoleAdmin)
	s, err := Open(dir, Options{Params: Params{Memory: 128, Time: 2, Threads: 1}})
	if err != nil {
		t.Fatal(err)
	}
	u, err := s.Login(context.Background(), "alice", pw)
	if err != nil || !strings.Contains(u.Hash, "$m=128,t=2,p=1$") {
		t.Errorf("%v %s", err, u.Hash)
	}
	if _, err := s.Login(context.Background(), "alice", pw); err != nil {
		t.Error(err)
	}
}

func TestLinks(t *testing.T) {
	clk := &clock{t: time.Date(2026, 10, 16, 8, 0, 0, 0, time.UTC)}
	s := open(t, t.TempDir(), clk)
	ctx := context.Background()
	bob, code, err := s.Add("bob", "Bob B.", RoleUser)
	if err != nil || len(code) < 40 || bob.Hash != "" || bob.Display() != "Bob B." {
		t.Fatal(bob, err)
	}
	data, _ := os.ReadFile(s.Path())
	if strings.Contains(string(data), code) {
		t.Error("the link code is in the file")
	}
	if u, err := s.LinkUser(code); err != nil || u.ID != bob.ID {
		t.Fatal(u, err)
	}
	if _, err := s.LinkUser(code + "x"); err != ErrLink {
		t.Error(err)
	}
	if _, err := s.UseLink(ctx, code, "short"); err == nil {
		t.Error("policy not applied")
	}
	u, err := s.UseLink(ctx, code, pw)
	if err != nil || u.Hash == "" || u.Epoch != 1 {
		t.Fatal(u, err)
	}
	if _, err := s.UseLink(ctx, code, pw+"2"); err != ErrLink {
		t.Error("used twice:", err)
	}
	if _, err := s.Login(ctx, "bob", pw); err != nil {
		t.Error(err)
	}
	// Reset: password gone, sessions end, a new link replaces older ones.
	old, _ := s.Reset(bob.ID)
	code, err = s.Reset(bob.ID)
	if err != nil {
		t.Fatal(err)
	}
	if u, _ := s.Get(bob.ID); u.Hash != "" || u.Epoch != 3 {
		t.Errorf("%+v", u)
	}
	if _, err := s.Login(ctx, "bob", pw); err != ErrInvalid {
		t.Error("old password after reset:", err)
	}
	if _, err := s.LinkUser(old); err != ErrLink {
		t.Error("older link still valid")
	}
	clk.add(LinkTTL)
	if _, err := s.UseLink(ctx, code, pw); err != ErrLink {
		t.Error("expired link used:", err)
	}
	_, _, _ = s.Add("carol", "", RoleUser) // a write drops expired links
	if data, _ := os.ReadFile(s.Path()); strings.Contains(string(data), codeHash(code)) {
		t.Error("expired link kept")
	}
}

func TestChangePassword(t *testing.T) {
	s := open(t, t.TempDir(), nil)
	ctx := context.Background()
	alice := addUser(t, s, "alice", RoleAdmin)
	if _, err := s.ChangePassword(ctx, alice.ID, "wrong", pw+" 2"); err == nil {
		t.Error("wrong current password accepted")
	}
	if _, err := s.ChangePassword(ctx, alice.ID, pw, pw); err == nil {
		t.Error("same password accepted")
	}
	if _, err := s.ChangePassword(ctx, alice.ID, pw, "alice"); err == nil {
		t.Error("policy not applied")
	}
	u, err := s.ChangePassword(ctx, alice.ID, pw, pw+" 2")
	if err != nil || u.Epoch != 1 {
		t.Fatal(u, err)
	}
	if _, err := s.Login(ctx, "alice", pw+" 2"); err != nil {
		t.Error(err)
	}
	// Guessing the current password is delayed like logins.
	for range 5 {
		_, _ = s.ChangePassword(ctx, alice.ID, "guess", pw+" 3")
	}
	var wait *WaitError
	if _, err := s.ChangePassword(ctx, alice.ID, pw+" 2", pw+" 3"); !errors.As(err, &wait) {
		t.Error("not delayed:", err)
	}
	if u, _ := s.EndSessions(alice.ID); u.Epoch != 2 {
		t.Error(u.Epoch)
	}
}

func TestLastAdmin(t *testing.T) {
	s := open(t, t.TempDir(), nil)
	ctx := context.Background()
	alice := addUser(t, s, "alice", RoleAdmin)
	bob := addUser(t, s, "bob", RoleUser)
	for name, err := range map[string]error{
		"disable": func() error { _, err := s.SetDisabled(alice.ID, true); return err }(),
		"demote":  func() error { _, err := s.SetRole(alice.ID, RoleUser); return err }(),
		"delete":  s.Delete(alice.ID),
	} {
		if err != ErrLastAdmin {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := s.SetRole(bob.ID, RoleAdmin); err != nil {
		t.Fatal(err)
	}
	if u, err := s.SetDisabled(alice.ID, true); err != nil || !u.Disabled || u.Epoch != 1 {
		t.Fatal(u, err)
	}
	// A disabled admin does not count.
	if _, err := s.SetRole(bob.ID, RoleUser); err != ErrLastAdmin {
		t.Error(err)
	}
	if err := s.Delete(alice.ID); err != nil {
		t.Error(err)
	}
	if _, ok := s.Get(alice.ID); ok {
		t.Error("not deleted")
	}
	if _, err := s.SetRole(bob.ID, "root"); err == nil {
		t.Error("unknown role")
	}
	if _, err := s.AddWithPassword(ctx, "first", "", RoleAdmin, pw, true, true); err != ErrNotEmpty {
		t.Error("first admin with users present:", err)
	}
	if err := s.Delete("nope"); err != ErrNotFound {
		t.Error(err)
	}
}

func TestCheck(t *testing.T) {
	s := open(t, t.TempDir(), nil)
	addUser(t, s, "alice", RoleAdmin)
	dir := filepath.Dir(s.Path())
	if err := s.Check(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.Path(), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.Check(); err == nil {
		t.Error("broken file passed")
	}
	if err := os.WriteFile(s.Path(), []byte(`{"version":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.Check(); err != nil {
		t.Error(err)
	}
	if os.Geteuid() != 0 { // root writes anyway
		os.Chmod(dir, 0o500)
		defer os.Chmod(dir, 0o700)
		if err := s.Check(); err == nil {
			t.Error("read-only directory passed")
		}
		os.Chmod(dir, 0o700)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 2 { // users.json, users.lock
		t.Errorf("left behind: %v", entries)
	}
}
