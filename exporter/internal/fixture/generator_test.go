package fixture

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/K4ugummi/ionos-explorer/exporter/internal/snapshot"
)

func load(t *testing.T) *snapshot.Snapshot {
	t.Helper()
	w, err := Generate(Options{Seed: 1})
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

type item struct {
	ID         string                     `json:"id"`
	Properties map[string]json.RawMessage `json:"properties"`
	Entities   map[string]struct {
		Items []item `json:"items"`
	} `json:"entities"`
}

func items(t *testing.T, s *snapshot.Snapshot, api, path string) []item {
	t.Helper()
	b, ok := s.Files[snapshot.RawFile(api, path)]
	if !ok {
		t.Fatalf("missing %s %s", api, path)
	}
	var c struct{ Items []item }
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatal(err)
	}
	return c.Items
}

func prop[T any](t *testing.T, it item, key string) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(it.Properties[key], &v); err != nil {
		t.Fatalf("%s.%s: %v", it.ID, key, err)
	}
	return v
}

func TestDeterministic(t *testing.T) {
	gen := func() []byte {
		w, err := Generate(Options{Seed: 7})
		if err != nil {
			t.Fatal(err)
		}
		var buf bytes.Buffer
		if err := w.WriteTo(&buf, snapshot.Options{}); err != nil {
			t.Fatal(err)
		}
		return buf.Bytes()
	}
	if !bytes.Equal(gen(), gen()) {
		t.Fatal("same seed produced different snapshots")
	}
}

// TestReferentialIntegrity checks the cross-references the explorer relies on
// when it builds the graph.
func TestReferentialIntegrity(t *testing.T) {
	s := load(t)

	for _, c := range s.Manifest.Coverage {
		if c.Status == snapshot.StatusOK {
			if _, ok := s.Files[c.File]; !ok {
				t.Errorf("coverage %s points to missing file %s", c.Path, c.File)
			}
		}
	}

	images := map[string]string{} // id -> location
	for _, img := range items(t, s, cloudAPI, "/images") {
		images[img.ID] = prop[string](t, img, "location")
	}
	appliances := 0

	dcs := items(t, s, cloudAPI, "/datacenters")
	if len(dcs) != 14 {
		t.Fatalf("want 14 datacenters, got %d", len(dcs))
	}

	type lanRef struct{ dc, lan string }
	lanPCC := map[lanRef]string{}
	nicIDs := map[string]bool{}
	seenIP := map[string]string{}
	serverTypes := map[string]int{}
	vips := map[string]bool{} // failover IPs legitimately sit on several NICs

	for _, dc := range dcs {
		base := "/datacenters/" + dc.ID
		lans := map[int]bool{}
		for _, l := range items(t, s, cloudAPI, base+"/lans") {
			var id int
			if err := json.Unmarshal([]byte(l.ID), &id); err != nil {
				t.Fatalf("LAN id %q is not numeric", l.ID)
			}
			lans[id] = true
			for _, f := range prop[[]struct{ IP string }](t, l, "ipFailover") {
				vips[f.IP] = true
			}
			if pcc := prop[*string](t, l, "pcc"); pcc != nil {
				lanPCC[lanRef{dc.ID, l.ID}] = *pcc
			}
		}
		volumes := map[string]bool{}
		for _, v := range items(t, s, cloudAPI, base+"/volumes") {
			volumes[v.ID] = true
		}
		for _, srv := range items(t, s, cloudAPI, base+"/servers") {
			serverTypes[prop[string](t, srv, "type")]++
			for _, v := range srv.Entities["volumes"].Items {
				if img := prop[*string](t, v, "image"); img != nil {
					appliances++
					if loc, ok := images[*img]; !ok || loc != prop[string](t, dc, "location") {
						t.Errorf("volume %s uses image %s not available in %s", v.ID, *img, prop[string](t, dc, "location"))
					}
				}
			}
			boot := prop[struct{ ID string }](t, srv, "bootVolume")
			if !volumes[boot.ID] {
				t.Errorf("server %s boot volume %s not in datacenter volumes", srv.ID, boot.ID)
			}
			for _, nic := range srv.Entities["nics"].Items {
				nicIDs[nic.ID] = true
				if lan := prop[int](t, nic, "lan"); !lans[lan] {
					t.Errorf("nic %s references missing LAN %d", nic.ID, lan)
				}
				for _, ip := range prop[[]string](t, nic, "ips") {
					if prev, dup := seenIP[ip]; dup && !vips[ip] {
						t.Errorf("IP %s assigned to %s and %s", ip, prev, nic.ID)
					}
					seenIP[ip] = nic.ID
				}
			}
		}
		for _, lb := range items(t, s, cloudAPI, base+"/networkloadbalancers") {
			for _, key := range []string{"listenerLan", "targetLan"} {
				if !lans[prop[int](t, lb, key)] {
					t.Errorf("NLB %s %s references missing LAN", lb.ID, key)
				}
			}
		}
	}

	if appliances == 0 {
		t.Error("fixture has no servers booting from a private appliance image")
	}

	for _, typ := range []string{"ENTERPRISE", "CUBE", "VCPU", "GPU"} {
		if serverTypes[typ] == 0 {
			t.Errorf("fixture has no %s server", typ)
		}
	}

	peered := map[lanRef]bool{}
	for _, pcc := range items(t, s, cloudAPI, "/pccs") {
		peers := prop[[]struct {
			ID           string `json:"id"`
			DatacenterID string `json:"datacenterId"`
			Location     string `json:"location"`
		}](t, pcc, "peers")
		for _, p := range peers {
			ref := lanRef{p.DatacenterID, p.ID}
			peered[ref] = true
			if lanPCC[ref] != pcc.ID {
				t.Errorf("PCC %s peer %v: LAN does not point back (has %q)", pcc.ID, ref, lanPCC[ref])
			}
			if p.Location != peers[0].Location {
				t.Errorf("PCC %s spans locations %s and %s", pcc.ID, peers[0].Location, p.Location)
			}
		}
	}
	for ref := range lanPCC {
		if !peered[ref] {
			t.Errorf("LAN %v has a pcc but is not listed as a peer", ref)
		}
	}

	for _, b := range items(t, s, cloudAPI, "/ipblocks") {
		for _, c := range prop[[]map[string]any](t, b, "ipConsumers") {
			if id, ok := c["nicId"].(string); ok && !nicIDs[id] {
				t.Errorf("ipblock %s consumer references missing NIC %s", b.ID, id)
			}
		}
	}

	forbidden := 0
	for _, c := range s.Manifest.Coverage {
		if c.Status == snapshot.StatusForbidden {
			forbidden++
		}
	}
	if forbidden == 0 {
		t.Error("fixture should exercise partial visibility (forbidden coverage)")
	}
}
