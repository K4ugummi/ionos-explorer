package fixture

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"
)

// HistoryAge is how much older the previous demo snapshot is.
const HistoryAge = 14 * 24 * time.Hour

// rewind turns the demo contract back into what it was two weeks earlier.
// The contract is built the same way first, so every ID stays the same and
// a comparison shows exactly the edits below, read backwards:
//
//   - fra-core-hub-01 was added since
//   - fra-core-legacy-01 was deleted since
//   - fra-core-api-01 went from 2 to 4 cores
//   - lab-old-notebook-01 was shut down since
//   - bastion-01 no longer allows RDP from the office
//   - txl-core-fw-01's transit NIC got another IP
//   - lhr-edge-gw-01 got the Security Group sg-edge-ipsec
//   - erp-app-01's label env changed from test to prod
//   - the DNS record beta.shop.example.com was added since
//
// It runs after building and before writing, and draws no random numbers,
// so the rest of the output is identical to the current snapshot.
func (g *gen) rewind() {
	g.dropServer("fra-core-hub-01")
	g.cloneServer("fra-core-web-04", "fra-core-legacy-01")

	props := func(o obj) obj { return o["properties"].(obj) }
	props(g.server("fra-core-api-01"))["cores"] = 2

	nb := g.server("lab-old-notebook-01")
	props(nb)["vmState"] = "RUNNING"
	nb["metadata"].(obj)["state"] = "AVAILABLE"

	for _, nic := range nics(g.server("bastion-01")) {
		if rules := nic["entities"].(obj)["firewallrules"].(obj); len(rules["items"].([]any)) > 0 {
			id := stableID("bastion-01/allow-rdp-office")
			rules["items"] = append(rules["items"].([]any), obj{
				"id": id, "type": "firewall-rule", "href": rules["href"].(string) + "/" + id,
				"metadata": obj{"createdDate": "2024-01-15T09:00:00Z", "createdBy": "a.mueller@example.com", "state": "AVAILABLE"},
				"properties": obj{"name": "allow-rdp-office", "protocol": "TCP", "sourceIp": officeIP, "portRangeStart": 3389,
					"portRangeEnd": 3389, "type": "INGRESS", "ipVersion": "IPv4"},
			})
		}
	}

	for _, nic := range nics(g.server("txl-core-fw-01")) {
		if props(nic)["name"] == "nic-transit-txl" {
			ip := props(nic)["ips"].([]any)[0].(string)
			props(nic)["ips"] = []any{ip[:strings.LastIndex(ip, ".")] + ".250"}
		}
	}

	gw := g.server("lhr-edge-gw-01")
	gw["entities"].(obj)["securitygroups"].(obj)["items"] = []any{}
	for _, d := range g.dcs {
		for _, sg := range d.sgs {
			if sg.spec.Name == "sg-edge-ipsec" {
				coll := sg.obj["entities"].(obj)["servers"].(obj)
				coll["items"] = slices.DeleteFunc(coll["items"].([]any), func(s any) bool { return s.(obj)["id"] == gw["id"] })
			}
		}
	}

	erp := g.server("erp-app-01")["id"]
	for _, l := range g.labels {
		if p := props(l.(obj)); p["resourceId"] == erp && p["key"] == "env" {
			p["value"] = "test"
		}
	}

	g.services.records = slices.DeleteFunc(g.services.records, func(r any) bool { return props(r.(obj))["name"] == "beta" })
}

func (g *gen) server(name string) obj {
	for _, d := range g.dcs {
		for _, s := range d.servers {
			if s.(obj)["properties"].(obj)["name"] == name {
				return s.(obj)
			}
		}
	}
	panic("history: no server " + name)
}

func nics(s obj) []obj {
	var out []obj
	for _, n := range s["entities"].(obj)["nics"].(obj)["items"].([]any) {
		out = append(out, n.(obj))
	}
	return out
}

// dropServer removes a server, its volumes and its labels.
func (g *gen) dropServer(name string) {
	s := g.server(name)
	id := s["id"]
	for _, d := range g.dcs {
		d.servers = slices.DeleteFunc(d.servers, func(x any) bool { return x.(obj)["id"] == id })
		d.volumes = slices.DeleteFunc(d.volumes, func(x any) bool {
			return strings.HasPrefix(x.(obj)["properties"].(obj)["name"].(string), name+"-")
		})
	}
	g.labels = slices.DeleteFunc(g.labels, func(x any) bool { return x.(obj)["properties"].(obj)["resourceId"] == id })
}

// cloneServer adds a copy of a server under another name, with its own IDs,
// MACs and private IPs (same subnet, host part +100).
func (g *gen) cloneServer(from, name string) {
	var c obj
	b, _ := json.Marshal(g.server(from))
	_ = json.Unmarshal(b, &c)
	old := c["id"].(string)
	id := stableID(name)
	c["id"], c["href"] = id, strings.Replace(c["href"].(string), old, id, 1)
	c["properties"].(obj)["name"] = name
	vols := c["entities"].(obj)["volumes"].(obj)["items"].([]any)
	for i, v := range vols {
		v.(obj)["id"] = stableID(fmt.Sprintf("%s/volume/%d", name, i))
		v.(obj)["properties"].(obj)["name"] = strings.Replace(v.(obj)["properties"].(obj)["name"].(string), from, name, 1)
		v.(obj)["properties"].(obj)["bootServer"] = id
	}
	if boot := c["properties"].(obj)["bootVolume"]; boot != nil && len(vols) > 0 {
		boot.(obj)["id"] = vols[0].(obj)["id"]
	}
	for i, n := range c["entities"].(obj)["nics"].(obj)["items"].([]any) {
		p := n.(obj)["properties"].(obj)
		n.(obj)["id"] = stableID(fmt.Sprintf("%s/nic/%d", name, i))
		p["mac"] = fmt.Sprintf("02:01:ee:00:00:%02x", i+1)
		var ips []any
		for _, ip := range p["ips"].([]any) {
			s := ip.(string)
			var host int
			fmt.Sscan(s[strings.LastIndex(s, ".")+1:], &host)
			ips = append(ips, fmt.Sprintf("%s.%d", s[:strings.LastIndex(s, ".")], host+100))
		}
		p["ips"] = ips
	}
	for _, d := range g.dcs {
		for _, s := range d.servers {
			if s.(obj)["id"] == old {
				d.servers = append(d.servers, c)
				d.volumes = append(d.volumes, vols...)
				return
			}
		}
	}
}

// stableID is a UUID derived from a name, so history edits draw no random numbers.
func stableID(name string) string {
	h := sha256.Sum256([]byte("ionos-fixture-history/" + name))
	h[6] = h[6]&0x0f | 0x40
	h[8] = h[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", h[0:4], h[4:6], h[6:8], h[8:10], h[10:16])
}
