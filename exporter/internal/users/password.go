package users

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"crypto/subtle"
	_ "embed"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

// Params are the argon2id parameters of new hashes. Hashes made with
// others still verify and are redone at the next login.
type Params struct {
	Memory  uint32 // KiB
	Time    uint32
	Threads uint8
}

// DefaultParams: 64 MiB, 3 passes, 1 thread (OWASP's argon2id minimums are
// lower; this costs about 0.1 s on a server core).
var DefaultParams = Params{Memory: 64 << 10, Time: 3, Threads: 1}

const (
	saltLen = 16
	keyLen  = 32
)

// hash makes a PHC string: $argon2id$v=19$m=65536,t=3,p=1$salt$key.
func hash(password string, p Params) string {
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		panic(err) // crypto/rand does not fail on supported systems
	}
	key := argon2.IDKey([]byte(password), salt, p.Time, p.Memory, p.Threads, keyLen)
	b64 := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, p.Memory, p.Time, p.Threads, b64.EncodeToString(salt), b64.EncodeToString(key))
}

var errBadHash = errors.New("not an argon2id hash")

// verify checks a password against a PHC string, in constant time, and
// reports whether the hash should be redone with p.
func verify(password, phc string, p Params) (ok, stale bool, err error) {
	parts := strings.Split(phc, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" || parts[2] != fmt.Sprintf("v=%d", argon2.Version) {
		return false, false, errBadHash
	}
	var got Params
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &got.Memory, &got.Time, &got.Threads); err != nil ||
		got.Memory < 8 || got.Memory > 4<<20 || got.Time < 1 || got.Time > 100 || got.Threads < 1 {
		return false, false, errBadHash
	}
	b64 := base64.RawStdEncoding
	salt, err1 := b64.DecodeString(parts[4])
	want, err2 := b64.DecodeString(parts[5])
	if err1 != nil || err2 != nil || len(salt) < 8 || len(want) < 16 {
		return false, false, errBadHash
	}
	key := argon2.IDKey([]byte(password), salt, got.Time, got.Memory, got.Threads, uint32(len(want)))
	ok = subtle.ConstantTimeCompare(key, want) == 1
	return ok, ok && (got != p || len(salt) != saltLen || len(want) != keyLen), nil
}

// Password rules (NIST SP 800-63B): length, not the username, not a common
// password. No composition rules.
const (
	MinPassword = 12
	MaxPassword = 256
)

// The most common passwords of 12 characters or more, lower case, from
// SecLists' xato-net-10-million-passwords-1000000.txt (MIT); see
// `make common-passwords`. Shorter ones are refused by length anyway.
//
//go:embed common-passwords.txt.gz
var commonGz []byte

var common = sync.OnceValue(func() map[string]struct{} {
	zr, err := gzip.NewReader(bytes.NewReader(commonGz))
	if err != nil {
		panic(err) // embedded at build time
	}
	set := map[string]struct{}{}
	sc := bufio.NewScanner(zr)
	for sc.Scan() {
		set[sc.Text()] = struct{}{}
	}
	return set
})

// CheckPassword says what is wrong with a new password, or nil.
func CheckPassword(username, password string) error {
	n := utf8.RuneCountInString(password)
	switch {
	case !utf8.ValidString(password):
		return inputf("the password is not valid text")
	case n < MinPassword:
		return inputf("the password needs at least %d characters (a few words make a good one)", MinPassword)
	case n > MaxPassword:
		return inputf("the password may have at most %d characters", MaxPassword)
	case strings.EqualFold(password, username):
		return inputf("the password must not be the username")
	}
	if _, found := common()[strings.ToLower(password)]; found {
		return inputf("this password is in lists of common passwords; choose another")
	}
	return nil
}
