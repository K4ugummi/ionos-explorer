package history

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"filippo.io/age"
)

const (
	alice = "local:ualice"
	bob   = "local:ubob"
)

func identity(t *testing.T) *age.X25519Identity {
	t.Helper()
	id, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func open(t *testing.T, dir string, opts Options, ids ...*age.X25519Identity) *Store {
	t.Helper()
	if len(ids) == 0 {
		ids = []*age.X25519Identity{identity(t)}
	}
	s, err := Open(dir, ids, opts)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func put(t *testing.T, s *Store, subject string, at time.Time, contract int64, body string) Entry {
	t.Helper()
	e, err := s.Put(subject, []byte(body), Meta{CreatedAt: at, Contract: contract, Collections: 5, Problems: 1, Partial: true})
	if err != nil {
		t.Fatal(err)
	}
	return e
}

var t0 = time.Date(2026, 10, 15, 8, 19, 4, 0, time.UTC)

func TestRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, Options{Now: func() time.Time { return t0 }})
	e := put(t, s, alice, t0, 1234, "snapshot one")
	if !idPattern.MatchString(e.ID) || !strings.HasPrefix(e.ID, "1234-20261015T081904Z-") {
		t.Fatalf("id %q", e.ID)
	}
	got, err := s.Get(alice, e.ID)
	if err != nil || string(got) != "snapshot one" {
		t.Fatalf("get: %q %v", got, err)
	}
	list, err := s.List(alice, "")
	if err != nil || len(list) != 1 {
		t.Fatalf("list: %v %v", list, err)
	}
	l := list[0]
	if l.ID != e.ID || l.Contract != "1234" || l.Collections != 5 || l.Problems != 1 || !l.Partial || l.Size != int64(len("snapshot one")) || !l.CreatedAt.Equal(t0) || l.Stored == 0 {
		t.Fatalf("entry %+v", l)
	}
	// A new store (a restart) reads the meta file again.
	s2 := open(t, dir, Options{}, s.ids[0].(*age.X25519Identity))
	if list2, _ := s2.List(alice, "1234"); len(list2) != 1 || list2[0].Collections != 5 {
		t.Fatalf("after restart %+v", list2)
	}

	// On disk: age files, 0600 in 0700 folders, no names.
	scope := filepath.Join(Root(dir), Scope(alice))
	for _, p := range []string{Root(dir), scope, filepath.Join(scope, "1234")} {
		if st, err := os.Stat(p); err != nil || st.Mode().Perm() != 0o700 {
			t.Fatalf("%s: %v %v", p, st.Mode(), err)
		}
	}
	files, _ := filepath.Glob(filepath.Join(scope, "1234", "*"))
	if len(files) != 2 {
		t.Fatalf("files %v", files)
	}
	for _, f := range files {
		st, _ := os.Stat(f)
		data, _ := os.ReadFile(f)
		if st.Mode().Perm() != 0o600 || !bytes.HasPrefix(data, []byte("age-encryption.org/v1\n")) || bytes.Contains(data, []byte("snapshot one")) {
			t.Fatalf("%s: mode %v, %q", f, st.Mode(), data[:min(30, len(data))])
		}
	}
	if strings.Contains(scope, "alice") {
		t.Fatal("the scope names the user")
	}

	if err := s.Delete(alice, e.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(alice, e.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("after delete: %v", err)
	}
	if err := s.Delete(alice, e.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete: %v", err)
	}
	if files, _ := filepath.Glob(filepath.Join(scope, "1234", "*")); len(files) != 0 {
		t.Fatalf("left %v", files)
	}
}

func TestUnknownContract(t *testing.T) {
	s := open(t, t.TempDir(), Options{})
	e := put(t, s, alice, t0, 0, "x")
	if e.Contract != "unknown" || !strings.HasPrefix(e.ID, "unknown-") {
		t.Fatalf("%+v", e)
	}
	if got, err := s.Get(alice, e.ID); err != nil || string(got) != "x" {
		t.Fatal(got, err)
	}
}

func TestScopesArePrivate(t *testing.T) {
	s := open(t, t.TempDir(), Options{})
	e := put(t, s, alice, t0, 1234, "alice's")
	if list, err := s.List(bob, ""); err != nil || len(list) != 0 {
		t.Fatalf("bob lists %v %v", list, err)
	}
	crafted := []string{
		e.ID,
		"../" + Scope(alice) + "/" + e.ID,
		Scope(alice) + "/1234/" + strings.TrimPrefix(e.ID, "1234-") + snapExt,
		"/etc/passwd",
		"..%2F" + e.ID,
		"1234-20261015T081904Z-zzzzzzzz",
		"1234/../../x-20261015T081904Z-00000000",
		e.ID + "\x00",
		"",
	}
	for _, id := range crafted {
		if _, err := s.Get(bob, id); !errors.Is(err, ErrNotFound) {
			t.Errorf("bob gets %q: %v", id, err)
		}
		if err := s.Delete(bob, id); !errors.Is(err, ErrNotFound) {
			t.Errorf("bob deletes %q: %v", id, err)
		}
	}
	if list, _ := s.List(bob, "../"+Scope(alice)); len(list) != 0 {
		t.Fatal("contract filter escapes the scope")
	}
	if got, err := s.Get(alice, e.ID); err != nil || string(got) != "alice's" {
		t.Fatal("alice lost it", err)
	}
}

func TestRetention(t *testing.T) {
	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC) // a Saturday
	var entries []Entry
	// Four a day for a year and a half, newest first.
	for at := now; at.After(now.AddDate(-1, -6, 0)); at = at.Add(-6 * time.Hour) {
		entries = append(entries, Entry{ID: at.Format(stampLayout), Meta: Meta{CreatedAt: at}})
	}
	keep := Retained(entries, DefaultKeep, now)
	var kept []time.Time
	for i, k := range keep {
		if k {
			kept = append(kept, entries[i].CreatedAt)
		}
	}
	// Newest 3; 14 days (today's newest is among the 3); weeks and months
	// add the newest of each older one: Sunday evenings of 8 weeks, of which
	// the 2 most recent fall in the 14 days, and the last day of 12 months,
	// of which this month's falls in the days.
	want := map[time.Time]bool{}
	for i := range 3 {
		want[now.Add(time.Duration(-6*i)*time.Hour)] = true
	}
	for i := range 14 {
		want[time.Date(2026, 10, 17-i, 18, 0, 0, 0, time.UTC)] = true
	}
	delete(want, time.Date(2026, 10, 17, 18, 0, 0, 0, time.UTC)) // in the future: there is none
	want[now] = true
	for i := range 8 { // Sundays 18:00 of the weeks before this one
		if i == 0 {
			continue // this week: today's newest
		}
		want[time.Date(2026, 10, 18-7*i, 18, 0, 0, 0, time.UTC)] = true
	}
	for i := 1; i < 12; i++ { // the last evening of the 11 months before
		first := time.Date(2026, time.Month(10-i+1), 1, 0, 0, 0, 0, time.UTC)
		want[first.Add(-6*time.Hour)] = true
	}
	got := map[time.Time]bool{}
	for _, k := range kept {
		got[k] = true
	}
	for w := range want {
		if !got[w] {
			t.Errorf("not kept: %s", w)
		}
	}
	for g := range got {
		if !want[g] {
			t.Errorf("kept, unexpectedly: %s", g)
		}
	}
	if len(kept) != len(want) {
		t.Errorf("kept %d, want %d", len(kept), len(want))
	}

	// Nothing to keep by period: still the newest 3.
	if k := Retained(entries[:10], Keep{}, now); !k[0] || !k[1] || !k[2] || k[3] {
		t.Fatalf("newest 3: %v", k)
	}
}

func TestPutAppliesRetention(t *testing.T) {
	now := t0
	s := open(t, t.TempDir(), Options{Keep: Keep{Daily: 2}, Now: func() time.Time { return now }})
	for i := range 6 {
		put(t, s, alice, t0.Add(time.Duration(-24*i)*time.Hour), 1, "old")
	}
	// The other contract and the other user are not touched.
	put(t, s, alice, t0.AddDate(0, 0, -30), 2, "other contract")
	put(t, s, bob, t0.AddDate(0, 0, -30), 1, "other user")
	if list, _ := s.List(alice, "1"); len(list) != 3 {
		t.Fatalf("contract 1 keeps the newest 3: %d", len(list))
	}
	if list, _ := s.List(alice, "2"); len(list) != 1 {
		t.Fatal("contract 2")
	}
	now = t0.AddDate(0, 0, 400)
	if n, err := s.Prune(); err != nil || n != 0 {
		t.Fatalf("prune: %d %v (the newest 3 stay)", n, err)
	}
}

func TestQuota(t *testing.T) {
	// One a day, all kept by the retention.
	day := func(i int) time.Time { return t0.AddDate(0, 0, i) }
	s := open(t, t.TempDir(), Options{Keep: Keep{Daily: 100}, Now: func() time.Time { return day(20) }})
	big := strings.Repeat("x", 1000)
	var ids []string
	for i := range 5 {
		ids = append(ids, put(t, s, alice, day(i), 1, big).ID)
	}
	used, _ := s.Usage(alice)
	per := used / 5
	// Room for 4: the oldest goes.
	s.opts.MaxBytes = per * 4
	put(t, s, alice, day(10), 1, big)
	list, _ := s.List(alice, "")
	if len(list) != 4 || list[3].ID != ids[2] {
		t.Fatalf("after eviction: %d, oldest %s", len(list), list[len(list)-1].ID)
	}
	// Room for 2 only: the newest 3 cannot be evicted, nothing is deleted.
	s.opts.MaxBytes = per * 2
	if _, err := s.Put(alice, []byte(big), Meta{CreatedAt: day(11), Contract: 1}); !errors.Is(err, ErrQuota) {
		t.Fatalf("over quota: %v", err)
	}
	if list, _ := s.List(alice, ""); len(list) != 4 {
		t.Fatalf("refused store deleted something: %d", len(list))
	}
	// Bob has a quota of his own.
	put(t, s, bob, t0, 1, "small")
}

func TestKeyRotation(t *testing.T) {
	dir := t.TempDir()
	oldKey, newKey := identity(t), identity(t)
	s := open(t, dir, Options{}, oldKey)
	e := put(t, s, alice, t0, 1, "secret data")

	// New key first, old one still configured: old files read.
	s2 := open(t, dir, Options{}, newKey, oldKey)
	if got, err := s2.Get(alice, e.ID); err != nil || string(got) != "secret data" {
		t.Fatal(got, err)
	}
	if n, err := s2.Rekey(); err != nil || n != 2 {
		t.Fatalf("rekey: %d %v", n, err)
	}
	if n, err := s2.Rekey(); err != nil || n != 0 {
		t.Fatalf("rekey again: %d %v", n, err)
	}
	// The new key alone reads everything.
	s3 := open(t, dir, Options{}, newKey)
	if got, err := s3.Get(alice, e.ID); err != nil || string(got) != "secret data" {
		t.Fatal(got, err)
	}
	if list, _ := s3.List(alice, ""); len(list) != 1 || list[0].Collections != 5 {
		t.Fatalf("meta after rekey %+v", list)
	}
	// The old key alone does not.
	s4 := open(t, dir, Options{}, oldKey)
	if _, err := s4.Get(alice, e.ID); err == nil || errors.Is(err, ErrNotFound) {
		t.Fatalf("old key: %v", err)
	}
	if _, err := s4.Rekey(); err == nil {
		t.Fatal("rekey with a key that reads nothing should fail")
	}
}

func TestCrashLeavesNoPartialFile(t *testing.T) {
	now := t0
	s := open(t, t.TempDir(), Options{Now: func() time.Time { return now }})
	e := put(t, s, alice, t0, 1, "x")
	dir := filepath.Join(s.root, Scope(alice), "1")
	// A crash between writing and renaming leaves a hidden temporary file.
	tmp := filepath.Join(dir, ".tmp-123456")
	if err := os.WriteFile(tmp, []byte("age-encryption.org/v1\npartial"), 0o600); err != nil {
		t.Fatal(err)
	}
	// And one between the snapshot and its meta file: a snapshot alone.
	lone := strings.TrimPrefix(e.ID, "1-")
	lone = "20261016T000000Z" + lone[len("20261015T081904Z"):]
	if err := os.WriteFile(filepath.Join(dir, lone+snapExt), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	list, _ := s.List(alice, "")
	if len(list) != 2 || list[0].ID != "1-"+lone || list[0].CreatedAt.IsZero() || list[1].ID != e.ID {
		t.Fatalf("list %+v", list)
	}
	old := now.Add(-2 * time.Hour)
	if err := os.Chtimes(tmp, old, old); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Prune(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(tmp); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("stale temporary file left")
	}
}

func TestRemoveScope(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, Options{})
	put(t, s, alice, t0, 1, "a")
	put(t, s, bob, t0, 1, "b")
	if err := RemoveScope(dir, alice); err != nil {
		t.Fatal(err)
	}
	if list, _ := s.List(alice, ""); len(list) != 0 {
		t.Fatal("alice's history left")
	}
	if list, _ := s.List(bob, ""); len(list) != 1 {
		t.Fatal("bob's history gone")
	}
	if RemoveScope("", alice) == nil || RemoveScope(dir, "") == nil {
		t.Fatal("empty arguments accepted")
	}
}

func TestOpenRefuses(t *testing.T) {
	if _, err := Open("", []*age.X25519Identity{identity(t)}, Options{}); err == nil {
		t.Fatal("no data dir")
	}
	if _, err := Open(t.TempDir(), nil, Options{}); err == nil {
		t.Fatal("no identity")
	}
	if os.Geteuid() != 0 {
		ro := t.TempDir()
		if err := os.Chmod(ro, 0o500); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.Chmod(ro, 0o700) })
		if _, err := Open(ro, []*age.X25519Identity{identity(t)}, Options{}); err == nil || !strings.Contains(err.Error(), ro) {
			t.Fatalf("not writable: %v", err)
		}
	}
}

func TestParse(t *testing.T) {
	a, b := identity(t), identity(t)
	ids, err := ParseIdentities("# new\n" + a.String() + "\n\n  " + b.String() + "  \n")
	if err != nil || len(ids) != 2 || ids[0].String() != a.String() {
		t.Fatal(ids, err)
	}
	for _, bad := range []string{"", "# only a comment", "AGE-SECRET-KEY-1NOPE", a.Recipient().String()} {
		_, err := ParseIdentities(bad)
		if err == nil {
			t.Errorf("%q accepted", bad)
		} else if bad != "" && strings.Contains(err.Error(), bad) {
			t.Errorf("error quotes the text: %v", err)
		}
	}
	k, err := ParseKeep(" daily=7, monthly=24 ")
	if err != nil || k != (Keep{Daily: 7, Monthly: 24}) || k.String() != "daily=7,weekly=0,monthly=24" {
		t.Fatal(k, err)
	}
	for _, bad := range []string{"daily", "daily=-1", "yearly=2", "daily=x"} {
		if _, err := ParseKeep(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}
