package snapshot

import (
	"archive/zip"
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"filippo.io/age"
)

// ageMagic is the first line of every age-encrypted file.
const ageMagic = "age-encryption.org/v1"

// ErrEncrypted is returned by Read when the snapshot is age-encrypted and no
// identities were supplied.
var ErrEncrypted = errors.New("snapshot is age-encrypted; an identity or passphrase is required")

type Snapshot struct {
	Manifest Manifest
	Files    map[string][]byte
}

// Read parses a snapshot, decrypting it first when it is age-encrypted, and
// verifies every file against the manifest checksums.
func Read(r io.Reader, identities ...age.Identity) (*Snapshot, error) {
	br := bufio.NewReader(r)
	if head, _ := br.Peek(len(ageMagic)); string(head) == ageMagic {
		if len(identities) == 0 {
			return nil, ErrEncrypted
		}
		dec, err := age.Decrypt(br, identities...)
		if err != nil {
			return nil, fmt.Errorf("age: %w", err)
		}
		r = dec
	} else {
		r = br
	}

	data, err := io.ReadAll(r)
	if err != nil {
		return nil, err
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("not a snapshot container: %w", err)
	}

	s := &Snapshot{Files: map[string][]byte{}}
	var manifest []byte
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		b, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			return nil, fmt.Errorf("%s: %w", f.Name, err)
		}
		if f.Name == ManifestPath {
			manifest = b
		} else {
			s.Files[f.Name] = b
		}
	}
	if manifest == nil {
		return nil, errors.New("snapshot has no manifest.json")
	}
	if err := json.Unmarshal(manifest, &s.Manifest); err != nil {
		return nil, fmt.Errorf("manifest: %w", err)
	}
	if s.Manifest.FormatVersion > FormatVersion {
		return nil, fmt.Errorf("snapshot format %d is newer than supported %d", s.Manifest.FormatVersion, FormatVersion)
	}

	listed := map[string]bool{}
	for _, fe := range s.Manifest.Files {
		listed[fe.Path] = true
		b, ok := s.Files[fe.Path]
		if !ok {
			return nil, fmt.Errorf("%s: listed in manifest but missing", fe.Path)
		}
		sum := sha256.Sum256(b)
		if hex.EncodeToString(sum[:]) != fe.SHA256 {
			return nil, fmt.Errorf("%s: checksum mismatch", fe.Path)
		}
	}
	for p := range s.Files {
		if !listed[p] {
			return nil, fmt.Errorf("%s: not listed in manifest", p)
		}
	}
	return s, nil
}
