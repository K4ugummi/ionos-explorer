// Package history keeps the snapshots hosted mode fetched, per user, on the
// data volume: each one age-encrypted to the server's key, with retention
// and a quota per user. History is private: a user's snapshots live in a
// folder named by a hash of their identity, and every call takes that
// identity, never a path. See docs/ARCHITECTURE.md, "Snapshot history".
//
// Layout: DATA_DIR/v1/history/u-<hash>/<contract>/<time>-<random>.ionx.age,
// next to it the same name with .meta.age (what a list shows, so listing
// decrypts no snapshot). Only hashes, contract numbers and times are in
// clear text.
package history

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"filippo.io/age"
)

const (
	snapExt = ".ionx.age"
	metaExt = ".meta.age"
	// stampLayout is the time in names and IDs (UTC, as ionos-export names files).
	stampLayout = "20060102T150405Z"
	// unknownContract is the folder of snapshots without a contract number.
	unknownContract = "unknown"
	// keepNewest are always kept, whatever the retention says.
	keepNewest = 3
	// staleTemp is when a temporary file is left over from a crash.
	staleTemp = time.Hour
)

var (
	ErrNotFound = errors.New("no such snapshot in your history")
	ErrQuota    = errors.New("your history is full: delete older snapshots (the fetch itself is not affected)")

	// An ID is <contract>-<time>-<random>; nothing else is ever joined to a path.
	idPattern       = regexp.MustCompile(`^(unknown|[0-9]{1,20})-([0-9]{8}T[0-9]{6}Z)-([0-9a-f]{8})$`)
	namePattern     = regexp.MustCompile(`^([0-9]{8}T[0-9]{6}Z)-([0-9a-f]{8})$`)
	contractPattern = regexp.MustCompile(`^(unknown|[0-9]{1,20})$`)
)

// Meta is what the list shows of a snapshot, from its manifest.
type Meta struct {
	CreatedAt time.Time `json:"createdAt"`
	// Contract number; 0 when the snapshot has none.
	Contract int64 `json:"contract,omitempty"`
	// Collections read, and how many of them could not be read.
	Collections int  `json:"collections"`
	Problems    int  `json:"problems"`
	Partial     bool `json:"partial"`
	// Size of the snapshot, unencrypted.
	Size    int64  `json:"size"`
	Version string `json:"version,omitempty"`
}

// Entry is a stored snapshot.
type Entry struct {
	ID       string `json:"id"`
	Contract string `json:"contract"`
	Meta
	// Stored is the space it takes on the volume.
	Stored int64 `json:"stored"`
}

// Keep is the retention: besides the newest 3, the newest snapshot of each
// of the last Daily days, Weekly weeks (Monday to Sunday) and Monthly
// months (UTC), per contract.
type Keep struct{ Daily, Weekly, Monthly int }

// DefaultKeep is two weeks of days, two months of weeks, a year of months.
var DefaultKeep = Keep{Daily: 14, Weekly: 8, Monthly: 12}

// ParseKeep reads "daily=14,weekly=8,monthly=12"; left-out parts are 0.
func ParseKeep(text string) (Keep, error) {
	var k Keep
	for part := range strings.SplitSeq(text, ",") {
		if part = strings.TrimSpace(part); part == "" {
			continue
		}
		name, value, ok := strings.Cut(part, "=")
		n, err := strconv.Atoi(strings.TrimSpace(value))
		if !ok || err != nil || n < 0 || n > 10000 {
			return k, fmt.Errorf("keep %q: use daily=N,weekly=N,monthly=N", text)
		}
		switch strings.TrimSpace(name) {
		case "daily":
			k.Daily = n
		case "weekly":
			k.Weekly = n
		case "monthly":
			k.Monthly = n
		default:
			return k, fmt.Errorf("keep %q: use daily=N,weekly=N,monthly=N", text)
		}
	}
	return k, nil
}

func (k Keep) String() string {
	return fmt.Sprintf("daily=%d,weekly=%d,monthly=%d", k.Daily, k.Weekly, k.Monthly)
}

// ParseIdentities reads age X25519 identities (AGE-SECRET-KEY-1…), one per
// line; blank lines and # comments are skipped. The first encrypts new
// files, all of them are tried for reading (key rotation). Errors never
// quote the text.
func ParseIdentities(text string) ([]*age.X25519Identity, error) {
	var out []*age.X25519Identity
	for i, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		id, err := age.ParseX25519Identity(line)
		if err != nil {
			return nil, fmt.Errorf("age identity, line %d: not an age X25519 identity (AGE-SECRET-KEY-1…)", i+1)
		}
		out = append(out, id)
	}
	if len(out) == 0 {
		return nil, errors.New("age identity: none given (ionos-explorer keygen makes one)")
	}
	return out, nil
}

// Scope is the folder of a user's history: a hash of their identity
// ("local:<id>", "oidc:<provider>:<sub>"), so no name or email is on the
// volume.
func Scope(subject string) string {
	sum := sha256.Sum256([]byte(subject))
	return "u-" + hex.EncodeToString(sum[:16])
}

// Root is the history folder in a data directory.
func Root(dataDir string) string { return filepath.Join(dataDir, "v1", "history") }

// RemoveScope deletes a user's whole history (the user was deleted). It
// needs no key.
func RemoveScope(dataDir, subject string) error {
	if dataDir == "" || subject == "" {
		return errors.New("no data directory or user")
	}
	return os.RemoveAll(filepath.Join(Root(dataDir), Scope(subject)))
}

type Options struct {
	Keep Keep
	// MaxBytes is the most a user's history may take on the volume; 0: no limit.
	MaxBytes int64
	Now      func() time.Time
}

type Store struct {
	root string
	ids  []age.Identity
	rcp  age.Recipient
	opts Options

	mu    sync.Mutex
	metas map[string]Meta // by path of the .meta.age file; files never change
}

// Open opens (and creates) the history in dataDir. New files are encrypted
// to the first identity.
func Open(dataDir string, identities []*age.X25519Identity, opts Options) (*Store, error) {
	if dataDir == "" {
		return nil, errors.New("the history needs a data directory")
	}
	if len(identities) == 0 {
		return nil, errors.New("the history needs an age identity (ionos-explorer keygen makes one)")
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.MaxBytes < 0 {
		return nil, errors.New("the history quota must not be negative")
	}
	s := &Store{root: Root(dataDir), rcp: identities[0].Recipient(), opts: opts, metas: map[string]Meta{}}
	for _, id := range identities {
		s.ids = append(s.ids, id)
	}
	if err := os.MkdirAll(s.root, 0o700); err != nil {
		return nil, fmt.Errorf("history: %w", err)
	}
	if err := s.Check(); err != nil {
		return nil, fmt.Errorf("history: %s is not writable: %w", s.root, err)
	}
	return s, nil
}

// Check reports whether the history folder takes new files.
func (s *Store) Check() error {
	f, err := os.CreateTemp(s.root, ".check-*")
	if err != nil {
		return err
	}
	f.Close()
	return os.Remove(f.Name())
}

func contractDir(m Meta) string {
	if m.Contract > 0 {
		return strconv.FormatInt(m.Contract, 10)
	}
	return unknownContract
}

func randomHex() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand does not fail on supported systems
	}
	return hex.EncodeToString(b)
}

func (s *Store) encrypt(plain []byte) ([]byte, error) {
	var buf bytes.Buffer
	w, err := age.Encrypt(&buf, s.rcp)
	if err != nil {
		return nil, err
	}
	if _, err := w.Write(plain); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func decrypt(r io.Reader, ids ...age.Identity) ([]byte, error) {
	dec, err := age.Decrypt(r, ids...)
	if err != nil {
		return nil, err
	}
	return io.ReadAll(dec)
}

// Put stores a snapshot of a user, then applies the retention to its
// contract. When the quota would be exceeded, the oldest snapshots beyond
// the newest 3 of each contract go first; if that is not enough, nothing
// is deleted and ErrQuota is returned.
func (s *Store) Put(subject string, snapshot []byte, m Meta) (Entry, error) {
	if subject == "" {
		return Entry{}, errors.New("history: no user")
	}
	m.Size = int64(len(snapshot))
	if m.CreatedAt.IsZero() {
		m.CreatedAt = s.opts.Now()
	}
	m.CreatedAt = m.CreatedAt.UTC()
	sealed, err := s.encrypt(snapshot)
	if err != nil {
		return Entry{}, err
	}
	metaJSON, err := json.Marshal(m)
	if err != nil {
		return Entry{}, err
	}
	sealedMeta, err := s.encrypt(metaJSON)
	if err != nil {
		return Entry{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	scope := Scope(subject)
	contract := contractDir(m)
	size := int64(len(sealed) + len(sealedMeta))
	if err := s.makeRoom(scope, contract, size); err != nil {
		return Entry{}, err
	}
	dir := filepath.Join(s.root, scope, contract)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return Entry{}, err
	}
	name := m.CreatedAt.Format(stampLayout) + "-" + randomHex()
	if err := writeFile(dir, name+snapExt, sealed); err != nil {
		return Entry{}, err
	}
	if err := writeFile(dir, name+metaExt, sealedMeta); err != nil {
		os.Remove(filepath.Join(dir, name+snapExt))
		return Entry{}, err
	}
	s.metas[filepath.Join(dir, name+metaExt)] = m
	e := Entry{ID: contract + "-" + name, Contract: contract, Meta: m, Stored: size}
	if _, err := s.retain(scope, contract); err != nil {
		return e, err
	}
	return e, nil
}

// makeRoom deletes the oldest snapshots of a scope until size more fits in
// the quota, sparing the newest of each contract (of contract, one fewer:
// the new one is about to be the newest). Holds s.mu.
func (s *Store) makeRoom(scope, contract string, size int64) error {
	if s.opts.MaxBytes == 0 {
		return nil
	}
	all, err := s.list(scope, "")
	if err != nil {
		return err
	}
	var used int64
	for _, e := range all {
		used += e.Stored
	}
	if used+size <= s.opts.MaxBytes {
		return nil
	}
	// Newest first per contract; the ones beyond the spared may go.
	spared := map[string]int{}
	var evictable []Entry
	var free int64
	for _, e := range all { // newest first
		keep := keepNewest
		if e.Contract == contract {
			keep--
		}
		if spared[e.Contract] < keep {
			spared[e.Contract]++
			continue
		}
		evictable = append(evictable, e)
		free += e.Stored
	}
	if used-free+size > s.opts.MaxBytes {
		return ErrQuota
	}
	// Oldest first.
	slices.SortStableFunc(evictable, func(a, b Entry) int { return a.CreatedAt.Compare(b.CreatedAt) })
	for _, e := range evictable {
		if used+size <= s.opts.MaxBytes {
			break
		}
		if err := s.remove(scope, e.ID); err != nil {
			return err
		}
		used -= e.Stored
	}
	return nil
}

// writeFile writes data next to its final name, syncs it and renames it
// into place: a crash leaves a hidden temporary file (removed by Prune),
// never a partial snapshot.
func writeFile(dir, name string, data []byte) error {
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // gone after the rename
	if _, err = tmp.Write(data); err == nil {
		err = tmp.Sync()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(tmp.Name(), 0o600)
	}
	if err == nil {
		err = os.Rename(tmp.Name(), filepath.Join(dir, name))
	}
	if err != nil {
		return err
	}
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync() // the rename itself
		d.Close()
	}
	return nil
}

// List is a user's history, newest first: of one contract, or of all
// ("").
func (s *Store) List(subject, contract string) ([]Entry, error) {
	if contract != "" && !contractPattern.MatchString(contract) {
		return nil, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.list(Scope(subject), contract)
}

// list reads a scope's entries, newest first. Holds s.mu.
func (s *Store) list(scope, contract string) ([]Entry, error) {
	base := filepath.Join(s.root, scope)
	contracts := []string{contract}
	if contract == "" {
		dirs, err := os.ReadDir(base)
		if errors.Is(err, fs.ErrNotExist) {
			return []Entry{}, nil
		}
		if err != nil {
			return nil, err
		}
		contracts = nil
		for _, d := range dirs {
			if d.IsDir() && contractPattern.MatchString(d.Name()) {
				contracts = append(contracts, d.Name())
			}
		}
	}
	out := []Entry{}
	for _, c := range contracts {
		dir := filepath.Join(base, c)
		files, err := os.ReadDir(dir)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		for _, f := range files {
			name, ok := strings.CutSuffix(f.Name(), snapExt)
			if !ok || !f.Type().IsRegular() || !namePattern.MatchString(name) {
				continue
			}
			e := Entry{ID: c + "-" + name, Contract: c}
			if st, err := f.Info(); err == nil {
				e.Stored = st.Size()
			}
			metaPath := filepath.Join(dir, name+metaExt)
			if st, err := os.Stat(metaPath); err == nil {
				e.Stored += st.Size()
				e.Meta = s.meta(metaPath)
			}
			if e.CreatedAt.IsZero() {
				// Without its meta file (a crash between the two writes): what the name says.
				e.CreatedAt, _ = time.Parse(stampLayout, name[:len(stampLayout)])
			}
			out = append(out, e)
		}
	}
	slices.SortStableFunc(out, func(a, b Entry) int {
		if c := b.CreatedAt.Compare(a.CreatedAt); c != 0 {
			return c
		}
		return strings.Compare(b.ID, a.ID)
	})
	return out, nil
}

// meta reads (once) a meta file; an unreadable one gives an empty Meta.
// Holds s.mu.
func (s *Store) meta(path string) Meta {
	if m, ok := s.metas[path]; ok {
		return m
	}
	var m Meta
	f, err := os.Open(path)
	if err != nil {
		return m
	}
	defer f.Close()
	plain, err := decrypt(io.LimitReader(f, 1<<20), s.ids...)
	if err != nil || json.Unmarshal(plain, &m) != nil {
		return Meta{}
	}
	s.metas[path] = m
	return m
}

// paths are the two files of an ID, or false for anything that is not an ID.
func (s *Store) paths(scope, id string) (snap, meta string, ok bool) {
	p := idPattern.FindStringSubmatch(id)
	if p == nil {
		return "", "", false
	}
	dir := filepath.Join(s.root, scope, p[1])
	name := p[2] + "-" + p[3]
	return filepath.Join(dir, name+snapExt), filepath.Join(dir, name+metaExt), true
}

// Get decrypts a snapshot of a user's history.
func (s *Store) Get(subject, id string) ([]byte, error) {
	snap, _, ok := s.paths(Scope(subject), id)
	if !ok {
		return nil, ErrNotFound
	}
	f, err := os.Open(snap)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	plain, err := decrypt(f, s.ids...)
	if err != nil {
		return nil, fmt.Errorf("history: %s cannot be decrypted with the configured keys: %w", id, err)
	}
	return plain, nil
}

// Delete removes a snapshot from a user's history.
func (s *Store) Delete(subject, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.remove(Scope(subject), id)
}

// remove deletes an entry's files, the snapshot first. Holds s.mu.
func (s *Store) remove(scope, id string) error {
	snap, meta, ok := s.paths(scope, id)
	if !ok {
		return ErrNotFound
	}
	err := os.Remove(snap)
	if errors.Is(err, fs.ErrNotExist) {
		if _, merr := os.Stat(meta); merr != nil {
			return ErrNotFound
		}
		err = nil
	}
	if err != nil {
		return err
	}
	delete(s.metas, meta)
	if err := os.Remove(meta); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// RemoveUser deletes a user's whole history (the user was deleted).
func (s *Store) RemoveUser(subject string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	clear(s.metas)
	return os.RemoveAll(filepath.Join(s.root, Scope(subject)))
}

// Usage is what a user's history takes on the volume.
func (s *Store) Usage(subject string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	all, err := s.list(Scope(subject), "")
	var used int64
	for _, e := range all {
		used += e.Stored
	}
	return used, err
}

// MaxBytes is the quota per user (0: none).
func (s *Store) MaxBytes() int64 { return s.opts.MaxBytes }

// Retained reports which of entries (newest first, one contract) the
// retention keeps at now.
func Retained(entries []Entry, k Keep, now time.Time) []bool {
	keep := make([]bool, len(entries))
	for i := range entries {
		keep[i] = i < keepNewest
	}
	rules := []struct {
		n      int
		period func(time.Time) int
	}{{k.Daily, day}, {k.Weekly, week}, {k.Monthly, month}}
	for _, r := range rules {
		if r.n <= 0 {
			continue
		}
		current := r.period(now.UTC())
		seen := map[int]bool{}
		for i, e := range entries {
			p := r.period(e.CreatedAt.UTC())
			if current-p >= r.n || seen[p] {
				continue
			}
			seen[p] = true // newest first: the first of a period is its newest
			keep[i] = true
		}
	}
	return keep
}

func day(t time.Time) int { return int(t.Unix() / 86400) }

// week counts Monday-to-Sunday weeks (1970-01-01 was a Thursday).
func week(t time.Time) int { return (day(t) + 3) / 7 }

func month(t time.Time) int { return t.Year()*12 + int(t.Month()) - 1 }

// retain applies the retention to a scope's contract and answers how many
// snapshots it deleted. Holds s.mu.
func (s *Store) retain(scope, contract string) (int, error) {
	entries, err := s.list(scope, contract)
	if err != nil {
		return 0, err
	}
	n := 0
	for i, keep := range Retained(entries, s.opts.Keep, s.opts.Now()) {
		if keep {
			continue
		}
		if err := s.remove(scope, entries[i].ID); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// Prune applies the retention to every history and removes temporary files
// a crash left behind; it answers how many snapshots it deleted.
func (s *Store) Prune() (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	total := 0
	scopes, err := os.ReadDir(s.root)
	if err != nil {
		return 0, err
	}
	for _, sc := range scopes {
		if !sc.IsDir() || !strings.HasPrefix(sc.Name(), "u-") {
			continue
		}
		contracts, err := os.ReadDir(filepath.Join(s.root, sc.Name()))
		if err != nil {
			return total, err
		}
		for _, c := range contracts {
			if !c.IsDir() || !contractPattern.MatchString(c.Name()) {
				continue
			}
			s.removeStale(filepath.Join(s.root, sc.Name(), c.Name()))
			n, err := s.retain(sc.Name(), c.Name())
			total += n
			if err != nil {
				return total, err
			}
		}
	}
	return total, nil
}

// removeStale removes temporary files older than staleTemp. Holds s.mu.
func (s *Store) removeStale(dir string) {
	files, _ := os.ReadDir(dir)
	for _, f := range files {
		if !strings.HasPrefix(f.Name(), ".tmp-") {
			continue
		}
		if st, err := f.Info(); err == nil && s.opts.Now().Sub(st.ModTime()) > staleTemp {
			os.Remove(filepath.Join(dir, f.Name()))
		}
	}
}

// Rekey encrypts every file that the first identity cannot read to it
// (after a new key was put first); it answers how many it rewrote. Files
// no configured identity can read are an error and stay as they are.
func (s *Store) Rekey() (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	var failed []string
	err := filepath.WalkDir(s.root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		name := d.Name()
		if d.IsDir() || !(strings.HasSuffix(name, snapExt) || strings.HasSuffix(name, metaExt)) {
			return nil
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		if _, err := decrypt(f, s.ids[0]); err == nil {
			return nil
		}
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			return err
		}
		plain, err := decrypt(f, s.ids...)
		if err != nil {
			rel, _ := filepath.Rel(s.root, path)
			failed = append(failed, rel)
			return nil
		}
		sealed, err := s.encrypt(plain)
		clear(plain)
		if err != nil {
			return err
		}
		if err := writeFile(filepath.Dir(path), name, sealed); err != nil {
			return err
		}
		n++
		return nil
	})
	if err == nil && len(failed) > 0 {
		err = fmt.Errorf("%d files cannot be decrypted with any configured key (left as they are): %s", len(failed), strings.Join(failed, ", "))
	}
	return n, err
}
