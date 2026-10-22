package users

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // TOTP (RFC 6238) as authenticator apps implement it is HMAC-SHA-1
	"crypto/subtle"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net/url"
	"slices"
	"strings"
	"time"

	"filippo.io/age"
)

// Two-factor authentication for local users: TOTP (RFC 6238; HMAC-SHA-1,
// 6 digits, 30 s, one step either side), as every authenticator app does
// it, and 10 single-use recovery codes. The secret is kept age-encrypted
// to the server's identity (the one of the snapshot history); recovery
// codes only as SHA-256. A code works once: the last step used is kept.

const (
	totpDigits    = 6
	totpPeriod    = 30
	totpIssuer    = "IONOS Explorer"
	recoveryCount = 10
	sealPrefix    = "age:"
)

var (
	// ErrCode is a wrong second-factor code.
	ErrCode = errors.New("wrong code")
	// ErrNoKey: the server has no age identity to keep TOTP secrets with.
	ErrNoKey = errors.New("two-factor authentication needs the server's age identity (IONOS_EXPLORER_AGE_IDENTITY_FILE)")
)

// NewTOTPSecret is a new 160-bit TOTP secret.
func NewTOTPSecret() []byte {
	b := make([]byte, 20)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

// TOTPKey is the secret as authenticator apps take it typed in: base32,
// no padding.
func TOTPKey(secret []byte) string {
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(secret)
}

// TOTPURI is the otpauth:// address the enrolment QR code carries.
func TOTPURI(secret []byte, username string) string {
	q := url.Values{}
	q.Set("secret", TOTPKey(secret))
	q.Set("issuer", totpIssuer)
	q.Set("algorithm", "SHA1")
	q.Set("digits", fmt.Sprint(totpDigits))
	q.Set("period", fmt.Sprint(totpPeriod))
	return "otpauth://totp/" + url.PathEscape(totpIssuer+":"+username) + "?" + q.Encode()
}

// hotp is RFC 4226's code for a counter.
func hotp(secret []byte, counter uint64) string {
	mac := hmac.New(sha1.New, secret)
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], counter)
	mac.Write(msg[:])
	sum := mac.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	v := binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff
	return fmt.Sprintf("%0*d", totpDigits, v%1_000_000)
}

// TOTP is the code at t.
func TOTP(secret []byte, t time.Time) string { return hotp(secret, uint64(t.Unix()/totpPeriod)) }

// matchTOTP finds the step (now, or one either side) code belongs to,
// later than last (a code works once).
func matchTOTP(secret []byte, code string, now time.Time, last int64) (int64, bool) {
	cur := now.Unix() / totpPeriod
	for _, step := range []int64{cur - 1, cur, cur + 1} {
		if step > last && subtle.ConstantTimeCompare([]byte(hotp(secret, uint64(step))), []byte(code)) == 1 {
			return step, true
		}
	}
	return 0, false
}

// normalizeCode drops spaces and dashes and lowers the case.
func normalizeCode(code string) string {
	return strings.ToLower(strings.NewReplacer(" ", "", "-", "", "\t", "").Replace(code))
}

func isTOTPCode(code string) bool {
	if len(code) != totpDigits {
		return false
	}
	for _, c := range code {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

var recoveryAlphabet = base32.NewEncoding("abcdefghijkmnpqrstuvwxyz23456789").WithPadding(base32.NoPadding)

// newRecoveryCodes are 10 codes (50 random bits each, "xxxxx-xxxxx") and
// their hashes.
func newRecoveryCodes() (codes, hashes []string) {
	for range recoveryCount {
		b := make([]byte, 7)
		if _, err := rand.Read(b); err != nil {
			panic(err)
		}
		c := recoveryAlphabet.EncodeToString(b)[:10]
		codes = append(codes, c[:5]+"-"+c[5:])
		hashes = append(hashes, codeHash("recovery:"+c))
	}
	return codes, hashes
}

// CanSeal reports whether the store has a key for TOTP secrets.
func (s *Store) CanSeal() bool { return len(s.ids) > 0 }

func (s *Store) seal(secret []byte) (string, error) {
	if !s.CanSeal() {
		return "", ErrNoKey
	}
	var buf bytes.Buffer
	w, err := age.Encrypt(&buf, s.ids[0].Recipient())
	if err != nil {
		return "", err
	}
	if _, err := w.Write(secret); err != nil {
		return "", err
	}
	if err := w.Close(); err != nil {
		return "", err
	}
	return sealPrefix + base64.StdEncoding.EncodeToString(buf.Bytes()), nil
}

// unseal decrypts a TOTP secret with the given identities (all by default).
func (s *Store) unseal(sealed string, ids ...age.Identity) ([]byte, error) {
	if !s.CanSeal() {
		return nil, ErrNoKey
	}
	if len(ids) == 0 {
		for _, id := range s.ids {
			ids = append(ids, id)
		}
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(sealed, sealPrefix))
	if err != nil || !strings.HasPrefix(sealed, sealPrefix) {
		return nil, errors.New("a TOTP secret in the users file is damaged")
	}
	r, err := age.Decrypt(bytes.NewReader(raw), ids...)
	if err != nil {
		return nil, fmt.Errorf("a TOTP secret cannot be decrypted with the configured age identities: %w", err)
	}
	return io.ReadAll(r)
}

// HasTOTP reports whether some account has a second factor (it cannot log
// in without the key).
func (s *Store) HasTOTP() bool {
	found := false
	_ = s.read(func(f *file) { found = slices.ContainsFunc(f.Users, func(u User) bool { return u.TOTP != "" }) })
	return found
}

// checkPassword checks a user's current password, with the login delays.
func (s *Store) checkPassword(ctx context.Context, u User, password string) error {
	if u.Hash == "" {
		return ErrNotFound
	}
	s.mu.Lock()
	if fl := s.fails[u.Username]; fl != nil && s.now().Before(fl.until) {
		s.mu.Unlock()
		return &WaitError{fl.until.Sub(s.now())}
	}
	s.mu.Unlock()
	release, err := s.hashSlot(ctx)
	if err != nil {
		return err
	}
	match, _, _ := verify(password, u.Hash, s.params)
	release()
	if !match {
		s.fail(u.Username)
		return inputf("the current password is wrong")
	}
	return nil
}

// EnableTOTP turns on a user's second factor: the password, and a code of
// the new secret to show the app has it. It answers the recovery codes
// (shown once) and ends the user's other sessions.
func (s *Store) EnableTOTP(ctx context.Context, id, password string, secret []byte, code string) (User, []string, error) {
	if !s.CanSeal() {
		return User{}, nil, ErrNoKey
	}
	u, ok := s.Get(id)
	if !ok {
		return User{}, nil, ErrNotFound
	}
	if u.TOTP != "" {
		return User{}, nil, inputf("two-factor authentication is on already")
	}
	if err := s.checkPassword(ctx, u, password); err != nil {
		return User{}, nil, err
	}
	step, ok := matchTOTP(secret, normalizeCode(code), s.now(), 0)
	if !ok {
		return User{}, nil, inputf("that code is not right: check that the phone's clock is right, and try the next code")
	}
	sealed, err := s.seal(secret)
	if err != nil {
		return User{}, nil, err
	}
	codes, hashes := newRecoveryCodes()
	u, err = s.change(id, func(_ *file, u *User) error {
		if u.TOTP != "" {
			return inputf("two-factor authentication is on already")
		}
		u.TOTP, u.TOTPStep, u.Recovery = sealed, step, hashes
		u.Epoch++
		return nil
	})
	if err != nil {
		return User{}, nil, err
	}
	return u, codes, nil
}

// DisableTOTP turns off the user's own second factor (password required)
// and ends their other sessions.
func (s *Store) DisableTOTP(ctx context.Context, id, password string) (User, error) {
	u, ok := s.Get(id)
	if !ok {
		return User{}, ErrNotFound
	}
	if u.TOTP == "" {
		return User{}, inputf("two-factor authentication is off already")
	}
	if err := s.checkPassword(ctx, u, password); err != nil {
		return User{}, err
	}
	return s.ResetTOTP(id)
}

// ResetTOTP removes a user's second factor (an admin, the users command:
// the phone is lost) and ends their sessions.
func (s *Store) ResetTOTP(id string) (User, error) {
	return s.change(id, func(_ *file, u *User) error {
		u.TOTP, u.TOTPStep, u.Recovery = "", 0, nil
		u.Epoch++
		return nil
	})
}

// NewRecoveryCodes replaces a user's recovery codes (password required).
func (s *Store) NewRecoveryCodes(ctx context.Context, id, password string) (User, []string, error) {
	u, ok := s.Get(id)
	if !ok {
		return User{}, nil, ErrNotFound
	}
	if u.TOTP == "" {
		return User{}, nil, inputf("two-factor authentication is off")
	}
	if err := s.checkPassword(ctx, u, password); err != nil {
		return User{}, nil, err
	}
	codes, hashes := newRecoveryCodes()
	u, err := s.change(id, func(_ *file, u *User) error {
		u.Recovery = hashes
		return nil
	})
	return u, codes, err
}

// SecondFactor checks the second step of a login: a TOTP code (once each)
// or a recovery code (used up). Wrong codes count as failed logins of the
// username, with the same delays.
func (s *Store) SecondFactor(id, code string) (User, error) {
	u, ok := s.Get(id)
	if !ok || u.TOTP == "" || u.Disabled || u.Hash == "" {
		return User{}, ErrInvalid
	}
	now := s.now()
	s.mu.Lock()
	if fl := s.fails[u.Username]; fl != nil && now.Before(fl.until) {
		s.mu.Unlock()
		return User{}, &WaitError{fl.until.Sub(now)}
	}
	s.mu.Unlock()
	secret, err := s.unseal(u.TOTP)
	if err != nil {
		return User{}, err
	}
	defer clear(secret)
	code = normalizeCode(code)
	err = s.update(func(f *file) error {
		i := find(f, func(x User) bool { return x.ID == id })
		if i < 0 || f.Users[i].TOTP != u.TOTP || f.Users[i].Disabled {
			return ErrInvalid
		}
		x := &f.Users[i]
		if isTOTPCode(code) {
			step, ok := matchTOTP(secret, code, now, x.TOTPStep)
			if !ok {
				return ErrCode
			}
			x.TOTPStep = step
		} else {
			h := codeHash("recovery:" + code)
			j := slices.IndexFunc(x.Recovery, func(r string) bool { return subtle.ConstantTimeCompare([]byte(r), []byte(h)) == 1 })
			if j < 0 || len(code) > 64 {
				return ErrCode
			}
			x.Recovery = slices.Delete(slices.Clone(x.Recovery), j, j+1)
		}
		at := now.UTC()
		x.LastLogin = &at
		u = *x
		return nil
	})
	if errors.Is(err, ErrCode) {
		s.fail(u.Username)
		return User{}, ErrCode
	}
	if err != nil {
		return User{}, err
	}
	s.mu.Lock()
	delete(s.fails, u.Username)
	s.mu.Unlock()
	return u, nil
}

// RekeyTOTP encrypts every TOTP secret the first identity cannot read to
// it (after a new key was put first); it answers how many it rewrote.
func (s *Store) RekeyTOTP() (int, error) {
	if !s.CanSeal() {
		return 0, ErrNoKey
	}
	n := 0
	err := s.update(func(f *file) error {
		for i := range f.Users {
			sealed := f.Users[i].TOTP
			if sealed == "" {
				continue
			}
			if secret, err := s.unseal(sealed, s.ids[0]); err == nil {
				clear(secret)
				continue
			}
			secret, err := s.unseal(sealed)
			if err != nil {
				return fmt.Errorf("user %s: %w", f.Users[i].Username, err)
			}
			resealed, err := s.seal(secret)
			clear(secret)
			if err != nil {
				return err
			}
			f.Users[i].TOTP = resealed
			n++
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return n, nil
}
