package fixture

import (
	"encoding/json"
	"fmt"
	"strings"
)

// demoLinks are what a user of the demo contract would add by hand: the
// tunnel the two Cisco VMs build between Frankfurt and Berlin (invisible to
// the API), and the head office as a site, which also takes over the managed
// VPN tunnel to its public IP.
var demoLinks = []struct{ From, To, Label, Note string }{
	{"fra-core-vpn-01", "txl-core-vpn-01", "IPsec (in the VMs)", "Configured on the Catalyst 8000V pair, not visible in the API"},
	{"lhr-edge-gw-01", "site:demo-head-office", "IPsec backup", ""},
}

// demoIPFix is a NIC whose address was changed inside the VM (DHCP is off, so
// IONOS still shows the old one). The VM uses .254 of the same subnet.
var demoIPFix = struct{ Server, LAN, Note string }{
	"dr-fw-01", "app", "Re-addressed in the VM during the DR test; DCD not updated",
}

// Annotations returns the explorer annotations file (manual links, sites, IP corrections)
// for the demo contract generated with opts. See explorer/src/annotations.
func Annotations(opts Options) (out []byte, err error) {
	if opts.CreatedAt.IsZero() {
		opts.CreatedAt = DefaultCreatedAt
	}
	defer func() {
		if r := recover(); r != nil {
			out, err = nil, fmt.Errorf("fixture: %v", r)
		}
	}()
	g := newGen(opts)
	g.build()

	id := func(name string) string {
		if v, ok := g.serverIDs[name]; ok {
			return v
		}
		if len(name) > 5 && name[:5] == "site:" {
			return name
		}
		panic("unknown server " + name)
	}
	links := []obj{}
	for i, l := range demoLinks {
		link := obj{"id": fmt.Sprintf("demo-link-%d", i+1), "from": id(l.From), "to": id(l.To), "label": l.Label}
		if l.Note != "" {
			link["note"] = l.Note
		}
		links = append(links, link)
	}
	var fixNIC, fixIP string
	for _, d := range g.dcs {
		for _, s := range d.servers {
			if s.(obj)["properties"].(obj)["name"] != demoIPFix.Server {
				continue
			}
			for _, n := range s.(obj)["entities"].(obj)["nics"].(obj)["items"].([]any) {
				if n.(obj)["properties"].(obj)["name"] == "nic-"+demoIPFix.LAN {
					fixNIC = n.(obj)["id"].(string)
					ip := n.(obj)["properties"].(obj)["ips"].([]any)[0].(string)
					fixIP = ip[:strings.LastIndex(ip, ".")] + ".254"
				}
			}
		}
	}
	if fixNIC == "" {
		panic("demo IP fix: no NIC in LAN " + demoIPFix.LAN + " on " + demoIPFix.Server)
	}
	doc := obj{
		"format": "ionos-explorer-annotations", "version": 1, "contract": contractNumber,
		"sites": []obj{{"id": "demo-head-office", "name": "Head office", "hosts": []string{"192.0.2.10"}, "note": "Office firewall; reached by the managed VPN and the London ASA"}},
		"links": links,
		"ips":   []obj{{"nic": fixNIC, "ips": []string{fixIP}, "note": demoIPFix.Note}},
	}
	return json.MarshalIndent(doc, "", "  ")
}
