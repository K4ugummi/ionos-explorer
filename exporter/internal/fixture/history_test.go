package fixture

import (
	"bytes"
	"testing"

	"github.com/K4ugummi/ionos-explorer/exporter/internal/snapshot"
)

// The previous snapshot differs only by the edits in history.go: every other
// file is byte for byte the same, so a comparison shows nothing spurious.
func TestHistoryChangesOnlyWhatItSays(t *testing.T) {
	read := func(previous bool) *snapshot.Snapshot {
		w, err := Generate(Options{Seed: 1, Previous: previous})
		if err != nil {
			t.Fatal(err)
		}
		var buf bytes.Buffer
		if err := w.WriteTo(&buf, snapshot.Options{}); err != nil {
			t.Fatal(err)
		}
		s, err := snapshot.Read(&buf)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	now, before := read(false), read(true)
	if d := now.Manifest.CreatedAt.Sub(before.Manifest.CreatedAt); d != HistoryAge {
		t.Errorf("age %v", d)
	}
	var changed []string
	for path, b := range now.Files {
		if !bytes.Equal(b, before.Files[path]) {
			changed = append(changed, path)
		}
	}
	// Servers of three datacenters (hub, legacy, api; notebook; bastion; fw;
	// edge gw; erp), volumes of fra-prod-core, Security Groups, labels.
	if len(changed) == 0 || len(changed) > 12 {
		t.Errorf("%d files differ: %v", len(changed), changed)
	}
	for _, p := range changed {
		if p == "raw/cloudapi-v6/datacenters.json" || p == "raw/cloudapi-v6/pccs.json" {
			t.Errorf("%s should not change", p)
		}
	}
}
