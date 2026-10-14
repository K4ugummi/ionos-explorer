package snapshot

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"

	"filippo.io/age"
)

// Writer collects raw API documents and coverage entries in memory and
// serializes them into a deterministic .ionx container. Snapshot sizes are a
// few MB even for large contracts, so buffering is fine.
type Writer struct {
	manifest Manifest
	files    map[string][]byte
}

func NewWriter(m Manifest) *Writer {
	m.FormatVersion = FormatVersion
	m.Coverage = nil
	m.Files = nil
	return &Writer{manifest: m, files: map[string][]byte{}}
}

// AddRaw stores an API response body at path after canonicalizing it (sorted
// keys, 2-space indent, numbers preserved verbatim) so identical API state
// always produces identical bytes.
func (w *Writer) AddRaw(path string, body []byte) error {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return fmt.Errorf("%s: invalid JSON: %w", path, err)
	}
	return w.AddJSON(path, v)
}

// AddJSON stores v (encoded canonically) at path.
func (w *Writer) AddJSON(path string, v any) error {
	if !strings.HasPrefix(path, "raw/") {
		return fmt.Errorf("%s: data files must live under raw/", path)
	}
	if _, dup := w.files[path]; dup {
		return fmt.Errorf("%s: duplicate file", path)
	}
	b, err := encodeCanonical(v)
	if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	w.files[path] = b
	return nil
}

func (w *Writer) AddCoverage(c Coverage) {
	w.manifest.Coverage = append(w.manifest.Coverage, c)
}

// Options controls how the container is written. If Recipients is non-empty
// the zip is wrapped in an age envelope.
type Options struct {
	Recipients []age.Recipient
}

// WriteTo writes the finished snapshot to out.
func (w *Writer) WriteTo(out io.Writer, opts Options) error {
	if len(opts.Recipients) > 0 {
		enc, err := age.Encrypt(out, opts.Recipients...)
		if err != nil {
			return fmt.Errorf("age: %w", err)
		}
		if err := w.writeZip(enc); err != nil {
			return err
		}
		return enc.Close()
	}
	return w.writeZip(out)
}

func (w *Writer) writeZip(out io.Writer) error {
	paths := make([]string, 0, len(w.files))
	for p := range w.files {
		paths = append(paths, p)
	}
	sort.Strings(paths)

	m := w.manifest
	m.Files = make([]FileEntry, 0, len(paths))
	for _, p := range paths {
		sum := sha256.Sum256(w.files[p])
		m.Files = append(m.Files, FileEntry{Path: p, Size: int64(len(w.files[p])), SHA256: hex.EncodeToString(sum[:])})
	}
	sort.SliceStable(m.Coverage, func(i, j int) bool {
		a, b := m.Coverage[i], m.Coverage[j]
		if a.API != b.API {
			return a.API < b.API
		}
		return a.Path < b.Path
	})
	mb, err := encodeCanonical(m)
	if err != nil {
		return fmt.Errorf("manifest: %w", err)
	}

	zw := zip.NewWriter(out)
	write := func(name string, data []byte) error {
		// Fixed timestamp keeps the archive byte-identical across runs.
		fw, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: m.CreatedAt.UTC()})
		if err != nil {
			return err
		}
		_, err = fw.Write(data)
		return err
	}
	// Manifest first so streaming readers can inspect it before the data.
	if err := write(ManifestPath, mb); err != nil {
		return err
	}
	for _, p := range paths {
		if err := write(p, w.files[p]); err != nil {
			return err
		}
	}
	return zw.Close()
}

func encodeCanonical(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
