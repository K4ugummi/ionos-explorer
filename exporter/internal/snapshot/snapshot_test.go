package snapshot

import (
	"bytes"
	"errors"
	"strings"
	"testing"
	"time"

	"filippo.io/age"
)

func testWriter(t *testing.T) *Writer {
	t.Helper()
	w := NewWriter(Manifest{CreatedAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC), Generator: Generator{Name: "test"}})
	if err := w.AddRaw("raw/cloudapi-v6/datacenters.json", []byte(`{"items":[{"id":"a","n":12345678901234567890,"s":"<&>"}],"b":1}`)); err != nil {
		t.Fatal(err)
	}
	n := 1
	w.AddCoverage(Coverage{API: "cloudapi-v6", Path: "/datacenters", Status: StatusOK, File: "raw/cloudapi-v6/datacenters.json", Items: &n})
	return w
}

func TestRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	if err := testWriter(t).WriteTo(&buf, Options{}); err != nil {
		t.Fatal(err)
	}
	s, err := Read(bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if s.Manifest.FormatVersion != FormatVersion || len(s.Manifest.Files) != 1 || len(s.Manifest.Coverage) != 1 {
		t.Fatalf("unexpected manifest: %+v", s.Manifest)
	}
	got := string(s.Files["raw/cloudapi-v6/datacenters.json"])
	// Keys sorted, big numbers kept verbatim, no HTML escaping.
	for _, want := range []string{`"b": 1,`, `12345678901234567890`, `"<&>"`} {
		if !strings.Contains(got, want) {
			t.Errorf("canonical JSON missing %q:\n%s", want, got)
		}
	}
	if strings.Index(got, `"b"`) > strings.Index(got, `"items"`) {
		t.Errorf("keys not sorted:\n%s", got)
	}
}

func TestDeterministic(t *testing.T) {
	var a, b bytes.Buffer
	if err := testWriter(t).WriteTo(&a, Options{}); err != nil {
		t.Fatal(err)
	}
	if err := testWriter(t).WriteTo(&b, Options{}); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a.Bytes(), b.Bytes()) {
		t.Fatal("identical input produced different archives")
	}
}

func TestEncrypted(t *testing.T) {
	id, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := testWriter(t).WriteTo(&buf, Options{Recipients: []age.Recipient{id.Recipient()}}); err != nil {
		t.Fatal(err)
	}
	if _, err := Read(bytes.NewReader(buf.Bytes())); !errors.Is(err, ErrEncrypted) {
		t.Fatalf("want ErrEncrypted, got %v", err)
	}
	s, err := Read(bytes.NewReader(buf.Bytes()), id)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Files) != 1 {
		t.Fatalf("want 1 file, got %d", len(s.Files))
	}
}

func TestRejectsBadPaths(t *testing.T) {
	w := NewWriter(Manifest{})
	if err := w.AddRaw("manifest.json", []byte(`{}`)); err == nil {
		t.Error("expected error for file outside raw/")
	}
	if err := w.AddRaw("raw/x.json", []byte(`{`)); err == nil {
		t.Error("expected error for invalid JSON")
	}
	if err := w.AddRaw("raw/x.json", []byte(`{}`)); err != nil {
		t.Fatal(err)
	}
	if err := w.AddRaw("raw/x.json", []byte(`{}`)); err == nil {
		t.Error("expected error for duplicate path")
	}
}

func TestRawFile(t *testing.T) {
	if got := RawFile("cloudapi-v6", "/datacenters/x/servers"); got != "raw/cloudapi-v6/datacenters/x/servers.json" {
		t.Fatal(got)
	}
}
