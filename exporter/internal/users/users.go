// Package users keeps the local user accounts of ionos-explorer's hosted
// mode in DATA_DIR/v1/users.json: argon2id password hashes, roles, one-time
// links to set a password. The server and the `ionos-explorer users`
// command share the file; each change is made under a file lock and
// written atomically, and readers notice changes. See docs/ARCHITECTURE.md,
// "Local users".
package users

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"filippo.io/age"
)

const (
	RoleAdmin = "admin"
	RoleUser  = "user"
)

// LinkTTL is how long a link to set a password is valid.
const LinkTTL = 24 * time.Hour

// User is one account. Hash is empty until a password is set (a new user
// with a pending link).
type User struct {
	ID         string     `json:"id"`
	Username   string     `json:"username"`
	Name       string     `json:"name,omitempty"`
	Role       string     `json:"role"`
	Hash       string     `json:"hash,omitempty"`
	MustChange bool       `json:"mustChangePassword,omitempty"`
	Disabled   bool       `json:"disabled,omitempty"`
	Created    time.Time  `json:"created"`
	LastLogin  *time.Time `json:"lastLogin,omitempty"`
	// Epoch goes up when the password changes, the account is disabled or
	// its sessions are ended: sessions started with an older one end.
	Epoch int `json:"sessionEpoch"`
	// TOTP is the second factor's secret, age-encrypted to the server's
	// identity ("" when off); TOTPStep the last time step used (a code works
	// once); Recovery the SHA-256 of the unused recovery codes.
	TOTP     string   `json:"totp,omitempty"`
	TOTPStep int64    `json:"totpStep,omitempty"`
	Recovery []string `json:"recovery,omitempty"`
}

// Display is the name to show.
func (u User) Display() string {
	if u.Name != "" {
		return u.Name
	}
	return u.Username
}

// link is a one-time link to set a user's password; only the code's hash
// is stored.
type link struct {
	Hash    string    `json:"hash"`
	UserID  string    `json:"userId"`
	Expires time.Time `json:"expires"`
}

type file struct {
	Version int    `json:"version"`
	Users   []User `json:"users"`
	Links   []link `json:"links,omitempty"`
}

var (
	ErrInvalid   = errors.New("wrong username or password")
	ErrBusy      = errors.New("the server is busy checking passwords; try again in a moment")
	ErrExists    = errors.New("that username is taken")
	ErrNotFound  = errors.New("no such user")
	ErrLastAdmin = errors.New("this is the last enabled admin; make someone else admin first")
	ErrNotEmpty  = errors.New("there are users already")
	ErrLink      = errors.New("this link is not valid (used already, expired or replaced by a newer one)")
)

// InputError is a refused password, name, username or role: a message for
// the user, not a failure of the store.
type InputError struct{ msg string }

func (e *InputError) Error() string { return e.msg }

func inputf(format string, a ...any) error { return &InputError{fmt.Sprintf(format, a...)} }

// IsInput reports whether err is an InputError.
func IsInput(err error) bool {
	var ie *InputError
	return errors.As(err, &ie)
}

// WaitError refuses a login during the delay after repeated failures.
type WaitError struct{ Retry time.Duration }

func (e *WaitError) Error() string {
	return fmt.Sprintf("too many failed attempts for this username; try again in %s", e.Retry.Round(time.Second))
}

type Options struct {
	Params Params           // default DefaultParams
	Now    func() time.Time // default time.Now
	// Hashes limits the password hashes computed at once (default 2; each
	// takes Params.Memory).
	Hashes int
	// Identities keep TOTP secrets (the first encrypts); none: no second
	// factor can be set up, and accounts that have one cannot log in.
	Identities []*age.X25519Identity
}

type Store struct {
	dir, path string
	params    Params
	now       func() time.Time
	hashing   chan struct{}
	ids       []*age.X25519Identity
	busyWait  time.Duration // how long a hash waits for a slot
	dummy     string        // verified for unknown users, so they take as long

	mu    sync.Mutex
	f     file
	stamp fileStamp
	fails map[string]*failure
}

type fileStamp struct {
	mod  time.Time
	size int64
}

// failure counts failed logins of a username (known or not), in memory.
type failure struct {
	n     int
	until time.Time // no attempt before
	last  time.Time
}

// Open opens (and creates) the store in dataDir/v1.
func Open(dataDir string, opts Options) (*Store, error) {
	if dataDir == "" {
		return nil, errors.New("local users need a data directory")
	}
	if opts.Params == (Params{}) {
		opts.Params = DefaultParams
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Hashes <= 0 {
		opts.Hashes = 2
	}
	dir := filepath.Join(dataDir, "v1")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &Store{
		dir: dir, path: filepath.Join(dir, "users.json"), params: opts.Params, now: opts.Now,
		hashing: make(chan struct{}, opts.Hashes), busyWait: 3 * time.Second, fails: map[string]*failure{}, ids: opts.Identities,
	}
	s.dummy = hash(random(), s.params)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.reload(true); err != nil {
		return nil, err
	}
	return s, nil
}

// Path is the users file.
func (s *Store) Path() string { return s.path }

// Check reports whether the store works: the file reads (again, if it
// changed) and its directory takes new files.
func (s *Store) Check() error {
	s.mu.Lock()
	err := s.reload(false)
	s.mu.Unlock()
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(s.dir, ".check-*")
	if err != nil {
		return err
	}
	f.Close()
	return os.Remove(f.Name())
}

func random() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func newID() string {
	b := make([]byte, 9)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return "u" + hex.EncodeToString(b)
}

func codeHash(code string) string {
	sum := sha256.Sum256([]byte(code))
	return hex.EncodeToString(sum[:])
}

// reload reads the file if it changed since the last read. A file that
// cannot be parsed is an error and keeps the last good state (and is never
// overwritten). Holds s.mu.
func (s *Store) reload(force bool) error {
	st, err := os.Stat(s.path)
	if errors.Is(err, os.ErrNotExist) {
		s.f, s.stamp = file{Version: 1}, fileStamp{}
		return nil
	}
	if err != nil {
		return err
	}
	stamp := fileStamp{st.ModTime(), st.Size()}
	if !force && stamp == s.stamp {
		return nil
	}
	data, err := os.ReadFile(s.path)
	if err != nil {
		return err
	}
	var f file
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&f); err != nil {
		return fmt.Errorf("%s: %w (fix or remove it; it was not changed)", s.path, err)
	}
	if f.Version != 1 {
		return fmt.Errorf("%s: version %d, this program knows 1", s.path, f.Version)
	}
	seen := map[string]bool{}
	for _, u := range f.Users {
		if u.ID == "" || seen[u.ID] || seen["@"+u.Username] || NormalizeUsername(u.Username) != u.Username || (u.Role != RoleAdmin && u.Role != RoleUser) {
			return fmt.Errorf("%s: user %q is not valid (it was not changed)", s.path, u.Username)
		}
		seen[u.ID], seen["@"+u.Username] = true, true
	}
	s.f, s.stamp = f, stamp
	return nil
}

// update changes the file: under the file lock, on its current content,
// written to a temporary file, synced and renamed over it.
func (s *Store) update(change func(f *file) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	lock, err := os.OpenFile(filepath.Join(s.dir, "users.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := lockFile(lock); err != nil {
		return err
	}
	defer unlockFile(lock) //nolint:errcheck // closing releases it too
	// Read again under the lock: a change in the same clock tick with the
	// same size would not show in the stamp.
	if err := s.reload(true); err != nil {
		return err
	}
	f := s.f
	f.Users = slices.Clone(f.Users)
	now := s.now()
	f.Links = slices.DeleteFunc(slices.Clone(f.Links), func(l link) bool { return !now.Before(l.Expires) })
	if err := change(&f); err != nil {
		return err
	}
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(s.dir, "users-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // gone after the rename
	if _, err = tmp.Write(append(data, '\n')); err == nil {
		err = tmp.Sync()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(tmp.Name(), 0o600)
	}
	if err == nil {
		err = os.Rename(tmp.Name(), s.path)
	}
	if err != nil {
		return err
	}
	if d, err := os.Open(s.dir); err == nil {
		_ = d.Sync() // the rename itself
		d.Close()
	}
	return s.reload(true)
}

// read runs fn on the current state.
func (s *Store) read(fn func(f *file)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	err := s.reload(false)
	fn(&s.f)
	return err
}

var usernamePattern = regexp.MustCompile(`^[a-z0-9._@-]{1,64}$`)

// NormalizeUsername lower-cases and trims; "" when it is not a valid name.
func NormalizeUsername(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	if !usernamePattern.MatchString(name) {
		return ""
	}
	return name
}

// CheckName checks a display name.
func CheckName(name string) error {
	if utf8.RuneCountInString(name) > 100 || !utf8.ValidString(name) || strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return inputf("the name may have up to 100 characters, no control characters")
	}
	return nil
}

func find(f *file, pred func(u User) bool) int { return slices.IndexFunc(f.Users, pred) }

// Users lists all accounts, by username.
func (s *Store) Users() ([]User, error) {
	var out []User
	err := s.read(func(f *file) { out = slices.Clone(f.Users) })
	slices.SortFunc(out, func(a, b User) int { return strings.Compare(a.Username, b.Username) })
	return out, err
}

// Get returns the account with this id, as the file says now.
func (s *Store) Get(id string) (User, bool) {
	var u User
	found := false
	_ = s.read(func(f *file) {
		if i := find(f, func(u User) bool { return u.ID == id }); i >= 0 {
			u, found = f.Users[i], true
		}
	})
	return u, found
}

// Find returns the account with this username.
func (s *Store) Find(username string) (User, bool) {
	username = NormalizeUsername(username)
	var u User
	found := false
	err := s.read(func(f *file) {
		if i := find(f, func(u User) bool { return u.Username == username }); i >= 0 {
			u, found = f.Users[i], true
		}
	})
	return u, found && err == nil
}

// Empty reports whether there is no account yet.
func (s *Store) Empty() (bool, error) {
	empty := false
	err := s.read(func(f *file) { empty = len(f.Users) == 0 })
	return empty, err
}

// Locked reports whether a username is inside its delay after failures.
func (s *Store) Locked(username string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	fl := s.fails[username]
	return fl != nil && s.now().Before(fl.until)
}

// hashSlot waits briefly for one of the hash slots.
func (s *Store) hashSlot(ctx context.Context) (release func(), err error) {
	t := time.NewTimer(s.busyWait)
	defer t.Stop()
	select {
	case s.hashing <- struct{}{}:
		return func() { <-s.hashing }, nil
	case <-t.C:
		return nil, ErrBusy
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Hash hashes a new password, waiting for a hash slot.
func (s *Store) hash(ctx context.Context, password string) (string, error) {
	release, err := s.hashSlot(ctx)
	if err != nil {
		return "", err
	}
	defer release()
	return hash(password, s.params), nil
}

const (
	freeFailures = 5
	maxDelay     = 15 * time.Minute
)

// Login checks a username and password. Unknown users, users without a
// password, disabled users and wrong passwords all answer ErrInvalid after
// the same work. After 5 failures of a username each attempt waits 1 s,
// 2 s, 4 s … up to 15 minutes; inside the delay even the right password is
// refused (WaitError).
func (s *Store) Login(ctx context.Context, username, password string) (User, error) {
	username = NormalizeUsername(username)
	now := s.now()
	s.mu.Lock()
	if fl := s.fails[username]; fl != nil && now.Before(fl.until) {
		s.mu.Unlock()
		return User{}, &WaitError{fl.until.Sub(now)}
	}
	s.mu.Unlock()

	u, found := s.Find(username)
	phc := s.dummy
	if found && u.Hash != "" && !u.Disabled {
		phc = u.Hash
	}
	if len(password) > 4*MaxPassword {
		s.fail(username)
		return User{}, ErrInvalid
	}
	release, err := s.hashSlot(ctx)
	if err != nil {
		return User{}, err
	}
	ok, stale, verr := verify(password, phc, s.params)
	release()
	if verr != nil || !ok || phc == s.dummy {
		s.fail(username)
		return User{}, ErrInvalid
	}

	// With a second factor the failures count on until the code is right:
	// knowing the password does not buy fresh guesses.
	if u.TOTP == "" {
		s.mu.Lock()
		delete(s.fails, username)
		s.mu.Unlock()
	}
	var newHash string
	if stale {
		if newHash, err = s.hash(ctx, password); err != nil {
			newHash = "" // next time
		}
	}
	err = s.update(func(f *file) error {
		i := find(f, func(x User) bool { return x.ID == u.ID })
		if i < 0 || f.Users[i].Hash != u.Hash || f.Users[i].Disabled {
			return ErrInvalid // changed meanwhile
		}
		if f.Users[i].TOTP == "" { // else at the second step
			at := s.now().UTC()
			f.Users[i].LastLogin = &at
		}
		if newHash != "" {
			f.Users[i].Hash = newHash
		}
		u = f.Users[i]
		return nil
	})
	return u, err
}

func (s *Store) fail(username string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if len(s.fails) > 10000 { // bounded: forget quiet names
		for k, fl := range s.fails {
			if now.Sub(fl.last) > time.Hour {
				delete(s.fails, k)
			}
		}
	}
	fl := s.fails[username]
	if fl == nil {
		fl = &failure{}
		s.fails[username] = fl
	}
	fl.n++
	fl.last = now
	if fl.n >= freeFailures {
		d := maxDelay
		if shift := fl.n - freeFailures; shift < 10 {
			d = min(time.Second<<shift, maxDelay)
		}
		fl.until = now.Add(d)
	}
}

// enabledAdmins counts enabled admins other than id.
func enabledAdmins(f *file, except string) int {
	n := 0
	for _, u := range f.Users {
		if u.Role == RoleAdmin && !u.Disabled && u.ID != except {
			n++
		}
	}
	return n
}

func newUser(f *file, username, name, role string, now time.Time) (*User, error) {
	norm := NormalizeUsername(username)
	switch {
	case norm == "":
		return nil, inputf("usernames have 1 to 64 letters, digits and . _ @ -")
	case find(f, func(u User) bool { return u.Username == norm }) >= 0:
		return nil, ErrExists
	case role != RoleAdmin && role != RoleUser:
		return nil, inputf("role %q: admin or user", role)
	}
	if err := CheckName(name); err != nil {
		return nil, err
	}
	f.Users = append(f.Users, User{ID: newID(), Username: norm, Name: strings.TrimSpace(name), Role: role, Created: now.UTC()})
	return &f.Users[len(f.Users)-1], nil
}

// newLink adds a link for a user, replacing older ones, and returns its code.
func newLink(f *file, userID string, now time.Time) string {
	code := random()
	f.Links = slices.DeleteFunc(f.Links, func(l link) bool { return l.UserID == userID })
	f.Links = append(f.Links, link{Hash: codeHash(code), UserID: userID, Expires: now.Add(LinkTTL).UTC()})
	return code
}

// RecordLogin notes a login that did not go through Login (a link that set
// the password, the setup of the first admin).
func (s *Store) RecordLogin(id string) (User, error) {
	return s.change(id, func(_ *file, u *User) error {
		at := s.now().UTC()
		u.LastLogin = &at
		return nil
	})
}

// Add creates an account without a password and returns the code of its
// link to set one.
func (s *Store) Add(username, name, role string) (User, string, error) {
	var u User
	var code string
	err := s.update(func(f *file) error {
		nu, err := newUser(f, username, name, role, s.now())
		if err != nil {
			return err
		}
		code = newLink(f, nu.ID, s.now())
		u = *nu
		return nil
	})
	return u, code, err
}

// AddWithPassword creates an account with a password. With first, only
// when there is no account yet (the first admin).
func (s *Store) AddWithPassword(ctx context.Context, username, name, role, password string, mustChange, first bool) (User, error) {
	if err := CheckPassword(NormalizeUsername(username), password); err != nil {
		return User{}, err
	}
	h, err := s.hash(ctx, password)
	if err != nil {
		return User{}, err
	}
	var u User
	err = s.update(func(f *file) error {
		if first && len(f.Users) > 0 {
			return ErrNotEmpty
		}
		nu, err := newUser(f, username, name, role, s.now())
		if err != nil {
			return err
		}
		nu.Hash, nu.MustChange = h, mustChange
		u = *nu
		return nil
	})
	return u, err
}

// LinkUser returns the user a link is for.
func (s *Store) LinkUser(code string) (User, error) {
	var u User
	err := ErrLink
	rerr := s.read(func(f *file) {
		now := s.now()
		for _, l := range f.Links {
			if l.Hash == codeHash(code) && now.Before(l.Expires) {
				if i := find(f, func(u User) bool { return u.ID == l.UserID }); i >= 0 {
					u, err = f.Users[i], nil
				}
			}
		}
	})
	if rerr != nil {
		return User{}, rerr
	}
	return u, err
}

// UseLink sets the password of the link's user, once.
func (s *Store) UseLink(ctx context.Context, code, password string) (User, error) {
	u, err := s.LinkUser(code)
	if err != nil {
		return User{}, err
	}
	if err := CheckPassword(u.Username, password); err != nil {
		return User{}, err
	}
	h, err := s.hash(ctx, password)
	if err != nil {
		return User{}, err
	}
	err = s.update(func(f *file) error {
		li := slices.IndexFunc(f.Links, func(l link) bool { return l.Hash == codeHash(code) && l.UserID == u.ID })
		i := find(f, func(x User) bool { return x.ID == u.ID })
		if li < 0 || i < 0 {
			return ErrLink
		}
		f.Links = slices.Delete(f.Links, li, li+1)
		f.Users[i].Hash, f.Users[i].MustChange = h, false
		f.Users[i].Epoch++
		u = f.Users[i]
		return nil
	})
	return u, err
}

// ChangePassword sets a user's own password (current one required) and
// ends their other sessions (the epoch goes up).
func (s *Store) ChangePassword(ctx context.Context, id, current, password string) (User, error) {
	u, ok := s.Get(id)
	if !ok || u.Hash == "" {
		return User{}, ErrNotFound
	}
	// Guessed like a login: the same delays.
	s.mu.Lock()
	if fl := s.fails[u.Username]; fl != nil && s.now().Before(fl.until) {
		s.mu.Unlock()
		return User{}, &WaitError{fl.until.Sub(s.now())}
	}
	s.mu.Unlock()
	release, err := s.hashSlot(ctx)
	if err != nil {
		return User{}, err
	}
	match, _, _ := verify(current, u.Hash, s.params)
	release()
	if !match {
		s.fail(u.Username)
		return User{}, inputf("the current password is wrong")
	}
	if current == password {
		return User{}, inputf("the new password is the old one")
	}
	return s.SetPassword(ctx, id, password)
}

// SetPassword sets a password without the current one (the users command)
// and ends the user's sessions.
func (s *Store) SetPassword(ctx context.Context, id, password string) (User, error) {
	u, ok := s.Get(id)
	if !ok {
		return User{}, ErrNotFound
	}
	if err := CheckPassword(u.Username, password); err != nil {
		return User{}, err
	}
	h, err := s.hash(ctx, password)
	if err != nil {
		return User{}, err
	}
	return s.change(id, func(f *file, u *User) error {
		u.Hash, u.MustChange = h, false
		u.Epoch++
		f.Links = slices.DeleteFunc(f.Links, func(l link) bool { return l.UserID == id })
		return nil
	})
}

func (s *Store) change(id string, fn func(f *file, u *User) error) (User, error) {
	var out User
	err := s.update(func(f *file) error {
		i := find(f, func(u User) bool { return u.ID == id })
		if i < 0 {
			return ErrNotFound
		}
		if err := fn(f, &f.Users[i]); err != nil {
			return err
		}
		out = f.Users[i]
		return nil
	})
	return out, err
}

// Reset removes a user's password and returns the code of a new link to
// set one; their sessions end.
func (s *Store) Reset(id string) (string, error) {
	var code string
	_, err := s.change(id, func(f *file, u *User) error {
		u.Hash, u.MustChange = "", false
		u.Epoch++
		code = newLink(f, u.ID, s.now())
		return nil
	})
	return code, err
}

// EndSessions ends a user's sessions (the caller keeps its own by taking
// the new epoch).
func (s *Store) EndSessions(id string) (User, error) {
	return s.change(id, func(_ *file, u *User) error {
		u.Epoch++
		return nil
	})
}

// SetDisabled disables (ending the sessions) or enables an account.
func (s *Store) SetDisabled(id string, disabled bool) (User, error) {
	return s.change(id, func(f *file, u *User) error {
		if disabled && u.Role == RoleAdmin && !u.Disabled && enabledAdmins(f, u.ID) == 0 {
			return ErrLastAdmin
		}
		if disabled && !u.Disabled {
			u.Epoch++
		}
		u.Disabled = disabled
		return nil
	})
}

// SetRole changes a role.
func (s *Store) SetRole(id, role string) (User, error) {
	if role != RoleAdmin && role != RoleUser {
		return User{}, inputf("role %q: admin or user", role)
	}
	return s.change(id, func(f *file, u *User) error {
		if role != RoleAdmin && u.Role == RoleAdmin && !u.Disabled && enabledAdmins(f, u.ID) == 0 {
			return ErrLastAdmin
		}
		u.Role = role
		return nil
	})
}

// Delete removes an account and its links.
func (s *Store) Delete(id string) error {
	return s.update(func(f *file) error {
		i := find(f, func(u User) bool { return u.ID == id })
		if i < 0 {
			return ErrNotFound
		}
		if u := f.Users[i]; u.Role == RoleAdmin && !u.Disabled && enabledAdmins(f, u.ID) == 0 {
			return ErrLastAdmin
		}
		f.Users = slices.Delete(f.Users, i, i+1)
		f.Links = slices.DeleteFunc(f.Links, func(l link) bool { return l.UserID == id })
		return nil
	})
}
