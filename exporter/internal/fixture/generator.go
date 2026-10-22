// Package fixture generates a synthetic but realistic snapshot of an IONOS
// contract. The output uses the exact container layout and raw response
// shapes the exporter produces, so the explorer can be developed and tested
// without access to a real account.
package fixture

import (
	"encoding/base64"
	"fmt"
	"math/rand"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/K4ugummi/ionos-explorer/exporter/internal/endpoints"
	"github.com/K4ugummi/ionos-explorer/exporter/internal/snapshot"
)

const (
	cloudAPI  = "cloudapi-v6"
	cloudBase = "https://api.ionos.com/cloudapi/v6"

	contractNumber = 31812345
	officeIP       = "192.0.2.10/32"
)

// DefaultCreatedAt is used when Options.CreatedAt is zero, so the default
// fixture is byte-for-byte reproducible.
var DefaultCreatedAt = time.Date(2026, 10, 14, 6, 0, 0, 0, time.UTC)

type Options struct {
	Seed      int64
	CreatedAt time.Time
	Version   string
	// Previous generates the same contract as it was two weeks earlier (see
	// history.go), for comparing snapshots.
	Previous bool
}

type obj = map[string]any

// Generate builds the demo contract described in spec.go.
func Generate(opts Options) (w *snapshot.Writer, err error) {
	if opts.CreatedAt.IsZero() {
		opts.CreatedAt = DefaultCreatedAt
	}
	defer func() {
		// The generator panics on inconsistent specs; surface that as an error.
		if r := recover(); r != nil {
			w, err = nil, fmt.Errorf("fixture: %v", r)
		}
	}()

	g := newGen(opts)
	g.build()
	return g.w, nil
}

type gen struct {
	seed     int64
	previous bool
	rng      *rand.Rand
	now      time.Time
	w        *snapshot.Writer

	users        []user
	templates    map[string]template
	templateList []any
	images       map[string]string // location|name -> private image id
	imageList    []any
	subnets      map[string]bool
	pccs         map[string]*pcc
	pccOrder     []*pcc
	dcs          []*dc
	publicPool   []string
	blocks       []*ipBlock
	targetGroups []any
	clusters     map[string]*k8sCluster
	clusterOrder []*k8sCluster
	postgres     map[string][]any // region -> clusters
	labels       []any
	serverIPs    map[string]string           // server name -> first public IP
	serverIDs    map[string]string           // server name -> id
	vpn          map[string]map[string][]any // region -> ipsec|wireguard -> gateways
	vpnChildren  map[string][]any            // gateway id -> tunnels or peers
	lbIPs        map[string]string           // load balancer name -> public IP
	albCerts     map[string]string           // application load balancer name -> its server certificate's id
	services     *services                   // the APIs beyond the Cloud API, PostgreSQL and VPN (services.go)
	totals       struct{ cores, ram, ssdGB, hddGB, dasGB, nlb, nat int }
}

type user struct{ id, email string }

type template struct {
	id                    string
	cores, ram, storageGB int
}

type subnet struct {
	base string
	next int
}

func (s *subnet) host() string {
	s.next++
	return fmt.Sprintf("%s.%d", s.base, s.next)
}

type pcc struct {
	id, name, desc string
	sub            *subnet
	peers          []any
}

type lan struct {
	id       int
	spec     lanSpec
	sub      *subnet
	pcc      *pcc
	failover []any
}

type dc struct {
	spec    *dcSpec
	id      string
	lans    map[string]*lan
	order   []*lan
	servers []any
	volumes []any
	nats    []any
	nlbs    []any
	albs    []any
	sgs     []*secGroup
	// role -> lan key -> private IPs, used to wire load balancer targets
	roleIPs map[string]map[string][]string
}

type secGroup struct {
	spec    sgSpec
	obj     obj
	servers []any // references, filled in as servers are built
}

type ipBlock struct {
	id, name, location string
	ips                []string
	used               int
	consumers          []any
}

type k8sCluster struct {
	id, name, version string
	pools             []any
}

func newGen(opts Options) *gen {
	created := opts.CreatedAt.UTC()
	if opts.Previous {
		created = created.Add(-HistoryAge)
	}
	m := snapshot.Manifest{
		CreatedAt: created,
		Generator: snapshot.Generator{Name: "ionos-fixture", Version: opts.Version},
		Synthetic: true,
		Contract:  &snapshot.Contract{Number: contractNumber, Owner: "cloud-admins@example.com"},
	}
	for _, a := range endpoints.APIs {
		m.APIs = append(m.APIs, snapshot.API{ID: a.ID, Name: a.Name, Version: a.Version, BaseURL: a.BaseURL, Region: a.Region})
	}
	g := &gen{
		seed:        opts.Seed,
		previous:    opts.Previous,
		rng:         rand.New(rand.NewSource(opts.Seed)),
		now:         opts.CreatedAt.UTC(),
		w:           snapshot.NewWriter(m),
		templates:   map[string]template{},
		images:      map[string]string{},
		subnets:     map[string]bool{},
		pccs:        map[string]*pcc{},
		clusters:    map[string]*k8sCluster{},
		serverIPs:   map[string]string{},
		serverIDs:   map[string]string{},
		vpn:         map[string]map[string][]any{},
		postgres:    map[string][]any{},
		vpnChildren: map[string][]any{},
		lbIPs:       map[string]string{},
		albCerts:    map[string]string{},
	}
	for _, e := range []string{"terraform@example.com", "terraform@example.com", "a.mueller@example.com", "j.schmidt@example.com", "k.weber@example.com"} {
		g.users = append(g.users, user{g.uuid(), e})
	}
	// Documentation ranges (RFC 5737) stand in for public IPs.
	for _, p := range []string{"203.0.113", "198.51.100"} {
		for i := 1; i < 255; i++ {
			g.publicPool = append(g.publicPool, fmt.Sprintf("%s.%d", p, i))
		}
	}
	return g
}

func (g *gen) build() {
	for _, t := range cubeTemplates {
		id := g.uuid()
		g.templates[t.Name] = template{id, t.Cores, t.RAM, t.Disk}
		g.templateList = append(g.templateList, obj{
			"id": id, "type": "template", "href": cloudBase + "/templates/" + id,
			"metadata":   g.meta("AVAILABLE"),
			"properties": obj{"name": t.Name, "cores": t.Cores, "ram": t.RAM, "storageSize": t.Disk},
		})
	}
	for _, p := range pccSpecs {
		c := &pcc{id: g.uuid(), name: p.Name, desc: p.Description, peers: []any{}}
		g.pccs[p.Name] = c
		g.pccOrder = append(g.pccOrder, c)
	}
	for i := range dcSpecs {
		g.buildDC(&dcSpecs[i])
	}
	for _, v := range vpnSpecs {
		g.buildVPN(v)
	}
	// A reserved block nobody uses: typical leftover worth spotting.
	g.newBlock("de/fra", "ipb-de-fra-reserve", 4)
	g.buildServices()

	if g.previous {
		g.rewind()
	}
	g.emitAll()
}

// --- datacenters -------------------------------------------------------------

func (g *gen) buildDC(s *dcSpec) {
	d := &dc{spec: s, id: g.uuid(), lans: map[string]*lan{}, roleIPs: map[string]map[string][]string{}}
	g.dcs = append(g.dcs, d)
	g.label("datacenter", d.id, cloudBase+"/datacenters/"+d.id, "env", s.Env)

	for i, ls := range s.LANs {
		l := &lan{id: i + 1, spec: ls, failover: []any{}}
		if ls.PCC != "" {
			c := g.pccs[ls.PCC]
			if c == nil {
				panic("unknown PCC " + ls.PCC)
			}
			// All peers of a Cross Connect share one layer-2 segment.
			if c.sub == nil {
				c.sub = g.newSubnet()
			}
			l.sub, l.pcc = c.sub, c
			c.peers = append(c.peers, obj{
				"id": strconv.Itoa(l.id), "name": ls.Name,
				"datacenterId": d.id, "datacenterName": s.Name, "location": s.Location,
			})
		} else if !ls.Public {
			l.sub = g.newSubnet()
		}
		d.lans[ls.Key] = l
		d.order = append(d.order, l)
	}

	for _, sg := range s.SecurityGroups {
		g.buildSecurityGroup(d, sg)
	}
	for _, ss := range s.Servers {
		g.buildServerGroup(d, ss)
	}
	for _, sg := range d.sgs {
		sg.obj["entities"].(obj)["servers"] = g.entityCollection(sg.obj["href"].(string)+"/servers", sg.servers)
	}
	for _, name := range s.OrphanVolumes {
		d.volumes = append(d.volumes, g.volume(d, name, "HDD", 250, "", "", "UNKNOWN", nil))
	}
	if s.NAT != nil {
		g.buildNAT(d, s.NAT)
	}
	if s.NLB != nil {
		g.buildNLB(d, s.NLB)
	}
	if s.ALB != nil {
		g.buildALB(d, s.ALB)
	}
	for _, np := range s.NodePools {
		g.buildNodePool(d, np)
	}
	for _, pg := range s.Postgres {
		g.buildPostgres(d, pg)
	}
}

func (g *gen) buildServerGroup(d *dc, ss serverSpec) {
	var publicNICs []obj
	for i := 1; i <= ss.Count; i++ {
		name := fmt.Sprintf(ss.Name, i)
		sid := g.uuid()
		g.serverIDs[name] = sid
		href := fmt.Sprintf("%s/datacenters/%s/servers/%s", cloudBase, d.id, sid)
		cpu := cpuFamilies[d.spec.Location]

		cores, ram := ss.Cores, ss.RAM
		var templateID any
		bootType, bootGB := "SSD Premium", 50
		if ss.Type == "CUBE" {
			t, ok := g.templates[ss.Template]
			if !ok {
				panic("unknown template " + ss.Template)
			}
			cores, ram, templateID = t.cores, t.ram, t.id
			bootType, bootGB = "DAS", t.storageGB
		}
		image, licence := "ubuntu:22.04", "LINUX"
		if ss.Windows {
			image, licence, bootGB = "windows:2022", "WINDOWS2022", 100
		}

		if ss.Image != "" {
			image, licence = "", "OTHER"
		}
		vols := []any{g.volume(d, name+"-boot", bootType, bootGB, sid, image, licence, 1)}
		if ss.Image != "" {
			vols[0].(obj)["properties"].(obj)["image"] = g.privateImage(ss.Image, d.spec.Location, bootGB)
		}
		if ss.DataGB > 0 {
			dt := ss.DataType
			if dt == "" {
				dt = "SSD Standard"
			}
			vols = append(vols, g.volume(d, name+"-data", dt, ss.DataGB, sid, "", licence, 2))
		}
		d.volumes = append(d.volumes, vols...)
		g.totals.cores += cores
		g.totals.ram += ram

		var groups []any
		for _, sg := range d.sgs {
			if slices.Contains(sg.spec.Roles, ss.Role) {
				groups = append(groups, sg.obj)
				sg.servers = append(sg.servers, obj{"id": sid, "type": "server", "href": href})
			}
		}

		var nics []any
		for j, key := range ss.LANs {
			l := d.lans[key]
			if l == nil {
				panic(fmt.Sprintf("%s: server %s references unknown LAN %q", d.spec.Name, name, key))
			}
			nic := g.nic(d, l, sid, href, name, ss.Role, j, len(groups) == 0)
			nics = append(nics, nic)
			if l.spec.Public {
				publicNICs = append(publicNICs, nic)
			}
		}

		vmState, state := "RUNNING", "AVAILABLE"
		if ss.Stopped {
			vmState, state = "SHUTOFF", "INACTIVE"
		}
		boot := vols[0].(obj)
		d.servers = append(d.servers, obj{
			"id": sid, "type": "server", "href": href,
			"metadata": g.meta(state),
			"properties": obj{
				"name": name, "cores": cores, "ram": ram, "availabilityZone": g.pick("AUTO", "AUTO", "ZONE_1", "ZONE_2"),
				"vmState": vmState, "bootCdrom": nil,
				"bootVolume":   obj{"id": boot["id"], "type": "volume", "href": boot["href"]},
				"cpuFamily":    cpu,
				"type":         ss.Type,
				"templateUuid": templateID,
			},
			"entities": obj{
				"cdroms":         g.entityCollection(href+"/cdroms", []any{}),
				"volumes":        g.entityCollection(href+"/volumes", vols),
				"nics":           g.entityCollection(href+"/nics", nics),
				"securitygroups": g.entityCollection(href+"/securitygroups", groups),
			},
		})
		g.label("server", sid, href, "env", d.spec.Env)
		g.label("server", sid, href, "role", ss.Role)
	}

	// Failover VIP shared by an HA pair on the public LAN.
	if ss.PublicVIP && len(publicNICs) > 0 {
		first := publicNICs[0]
		vip := g.publicIP(d, obj{"nicId": first["id"], "serverName": fmt.Sprintf(ss.Name, 1), "mac": first["properties"].(obj)["mac"]})
		for _, n := range publicNICs {
			p := n["properties"].(obj)
			p["ips"] = append(p["ips"].([]any), vip)
		}
		for _, l := range d.order {
			if l.spec.Public {
				l.failover = append(l.failover, obj{"ip": vip, "nicUuid": first["id"]})
				break
			}
		}
	}
}

// Servers whose address is usually configured inside the VM. For their NICs
// the IP in the API is only a record: IONOS does not hand it out.
var staticRoles = map[string]bool{"firewall": true, "vpn": true, "database": true}

func (g *gen) nic(d *dc, l *lan, sid, serverHref, serverName, role string, idx int, firewall bool) obj {
	id := g.uuid()
	href := serverHref + "/nics/" + id
	mac := g.mac()
	var ip string
	rules := []any{}
	if l.spec.Public {
		ip = g.publicIP(d, obj{"nicId": id, "serverId": sid, "serverName": serverName, "mac": mac})
		if firewall {
			rules = g.firewallRules(href+"/firewallrules", role)
		}
		if _, ok := g.serverIPs[serverName]; !ok {
			g.serverIPs[serverName] = ip
		}
	} else {
		ip = l.sub.host()
		byLAN := d.roleIPs[role]
		if byLAN == nil {
			byLAN = map[string][]string{}
			d.roleIPs[role] = byLAN
		}
		byLAN[l.spec.Key] = append(byLAN[l.spec.Key], ip)
	}
	return obj{
		"id": id, "type": "nic", "href": href,
		"metadata": g.meta("AVAILABLE"),
		"properties": obj{
			"name": "nic-" + l.spec.Name, "mac": mac, "ips": []any{ip}, "dhcp": !staticRoles[role],
			"lan": l.id, "firewallActive": len(rules) > 0, "firewallType": "INGRESS",
			"deviceNumber": idx + 1, "pciSlot": idx + 6,
			"ipv6Ips": []any{}, "ipv6CidrBlock": nil, "dhcpv6": nil,
		},
		"entities": obj{
			"firewallrules":  g.entityCollection(href+"/firewallrules", rules),
			"flowlogs":       g.entityCollection(href+"/flowlogs", []any{}),
			"securitygroups": g.entityCollection(href+"/securitygroups", []any{}),
		},
	}
}

func (g *gen) buildSecurityGroup(d *dc, s sgSpec) {
	id := g.uuid()
	href := fmt.Sprintf("%s/datacenters/%s/securitygroups/%s", cloudBase, d.id, id)
	d.sgs = append(d.sgs, &secGroup{spec: s, obj: obj{
		"id": id, "type": "securitygroup", "href": href, "metadata": g.meta("AVAILABLE"),
		"properties": obj{"name": s.Name, "description": s.Description},
		"entities": obj{
			"rules": g.entityCollection(href+"/rules", g.firewallRules(href+"/rules", s.Rules)),
			"nics":  g.entityCollection(href+"/nics", []any{}),
		},
	}})
}

func (g *gen) firewallRules(collHref, role string) []any {
	type rule struct {
		name, proto, src string
		from, to         int
	}
	var rs []rule
	switch role {
	case "bastion":
		rs = []rule{{"allow-ssh-office", "TCP", officeIP, 22, 22}, {"allow-icmp", "ICMP", "", 0, 0}}
	case "vpn":
		rs = []rule{{"allow-ike", "UDP", "", 500, 500}, {"allow-nat-t", "UDP", "", 4500, 4500},
			{"allow-esp", "ESP", "", 0, 0}, {"allow-ssh-office", "TCP", officeIP, 22, 22}}
	case "firewall":
		rs = []rule{{"allow-https", "TCP", "", 443, 443}, {"allow-http", "TCP", "", 80, 80},
			{"allow-ike", "UDP", "", 500, 500}, {"allow-nat-t", "UDP", "", 4500, 4500}, {"allow-icmp", "ICMP", "", 0, 0}}
	default:
		rs = []rule{{"allow-https", "TCP", "", 443, 443}, {"allow-icmp", "ICMP", "", 0, 0}}
	}
	out := make([]any, 0, len(rs))
	for _, r := range rs {
		id := g.uuid()
		p := obj{
			"name": r.name, "protocol": r.proto, "sourceMac": nil, "sourceIp": nil, "targetIp": nil,
			"icmpCode": nil, "icmpType": nil, "portRangeStart": nil, "portRangeEnd": nil,
			"type": "INGRESS", "ipVersion": "IPv4",
		}
		if r.src != "" {
			p["sourceIp"] = r.src
		}
		if r.from > 0 {
			p["portRangeStart"], p["portRangeEnd"] = r.from, r.to
		}
		out = append(out, obj{"id": id, "type": "firewall-rule", "href": collHref + "/" + id, "metadata": g.meta("AVAILABLE"), "properties": p})
	}
	return out
}

func (g *gen) volume(d *dc, name, typ string, sizeGB int, serverID, image, licence string, device any) obj {
	id := g.uuid()
	switch typ {
	case "HDD":
		g.totals.hddGB += sizeGB
	case "DAS":
		g.totals.dasGB += sizeGB
	default:
		g.totals.ssdGB += sizeGB
	}
	var boot, alias any
	if serverID != "" {
		boot = serverID
	}
	if image != "" {
		alias = image
	}
	return obj{
		"id": id, "type": "volume", "href": fmt.Sprintf("%s/datacenters/%s/volumes/%s", cloudBase, d.id, id),
		"metadata": g.meta("AVAILABLE"),
		"properties": obj{
			"name": name, "type": typ, "size": sizeGB, "availabilityZone": "AUTO",
			"image": nil, "imageAlias": alias, "imagePassword": nil, "sshKeys": nil,
			"bus": "VIRTIO", "licenceType": licence,
			"cpuHotPlug": true, "ramHotPlug": true, "nicHotPlug": true, "nicHotUnplug": true,
			"discVirtioHotPlug": true, "discVirtioHotUnplug": true,
			"deviceNumber": device, "pciSlot": nil, "bootServer": boot, "backupunitId": nil,
		},
	}
}

// privateImage returns the id of an uploaded image. Images are per location,
// so the same appliance uploaded to two locations yields two images.
func (g *gen) privateImage(name, location string, sizeGB int) string {
	key := location + "|" + name
	if id, ok := g.images[key]; ok {
		return id
	}
	id := g.uuid()
	g.images[key] = id
	g.imageList = append(g.imageList, obj{
		"id": id, "type": "image", "href": cloudBase + "/images/" + id, "metadata": g.meta("AVAILABLE"),
		"properties": obj{
			"name": name + ".qcow2", "description": "", "location": location, "size": sizeGB,
			"public": false, "imageType": "HDD", "licenceType": "OTHER", "imageAliases": []any{},
			"cloudInit": "NONE", "exposeSerial": false, "requireLegacyBios": true,
			"cpuHotPlug": false, "ramHotPlug": false, "nicHotPlug": false, "nicHotUnplug": false,
			"discVirtioHotPlug": false, "discVirtioHotUnplug": false,
		},
	})
	return id
}

// --- network services --------------------------------------------------------

func (g *gen) buildNAT(d *dc, s *natSpec) {
	id := g.uuid()
	href := fmt.Sprintf("%s/datacenters/%s/natgateways/%s", cloudBase, d.id, id)
	pub := g.publicIP(d, obj{})
	lans, rules := []any{}, []any{}
	for _, key := range s.LANs {
		l := d.lans[key]
		lans = append(lans, obj{"id": l.id, "gatewayIps": []any{l.sub.base + ".1/24"}})
		rid := g.uuid()
		rules = append(rules, obj{
			"id": rid, "type": "natgateway-rule", "href": href + "/rules/" + rid, "metadata": g.meta("AVAILABLE"),
			"properties": obj{"name": "snat-" + l.spec.Name, "type": "SNAT", "protocol": "ALL",
				"sourceSubnet": l.sub.base + ".0/24", "publicIp": pub, "targetSubnet": nil, "targetPortRange": nil},
		})
	}
	g.totals.nat++
	d.nats = append(d.nats, obj{
		"id": id, "type": "natgateway", "href": href, "metadata": g.meta("AVAILABLE"),
		"properties": obj{"name": s.Name, "publicIps": []any{pub}, "lans": lans},
		"entities": obj{
			"rules":    g.entityCollection(href+"/rules", rules),
			"flowlogs": g.entityCollection(href+"/flowlogs", []any{}),
		},
	})
}

func (g *gen) lbLANs(d *dc, s *lbSpec) (listener, target *lan, targets []string) {
	listener, target = d.lans[s.Listener], d.lans[s.Target]
	if listener == nil || target == nil {
		panic(fmt.Sprintf("%s: load balancer %s references unknown LAN", d.spec.Name, s.Name))
	}
	targets = d.roleIPs[s.TargetRole][s.Target]
	if len(targets) == 0 {
		panic(fmt.Sprintf("%s: load balancer %s has no %s targets on %s", d.spec.Name, s.Name, s.TargetRole, s.Target))
	}
	return listener, target, targets
}

func (g *gen) buildNLB(d *dc, s *lbSpec) {
	listener, target, targets := g.lbLANs(d, s)
	id := g.uuid()
	href := fmt.Sprintf("%s/datacenters/%s/networkloadbalancers/%s", cloudBase, d.id, id)
	pub := g.publicIP(d, obj{})
	g.lbIPs[s.Name] = pub
	ts := []any{}
	for _, ip := range targets {
		ts = append(ts, obj{"ip": ip, "port": s.Port, "weight": 1, "proxyProtocol": "none",
			"healthCheck": obj{"check": true, "checkInterval": 2000, "maintenance": false}})
	}
	rid := g.uuid()
	rule := obj{
		"id": rid, "type": "forwarding-rule", "href": href + "/forwardingrules/" + rid, "metadata": g.meta("AVAILABLE"),
		"properties": obj{"name": fmt.Sprintf("tcp-%d", s.Port), "algorithm": "ROUND_ROBIN", "protocol": "TCP",
			"listenerIp": pub, "listenerPort": s.Port, "targets": ts,
			"healthCheck": obj{"clientTimeout": 50000, "connectTimeout": 5000, "targetTimeout": 50000, "retries": 3}},
	}
	g.totals.nlb++
	d.nlbs = append(d.nlbs, obj{
		"id": id, "type": "networkloadbalancer", "href": href, "metadata": g.meta("AVAILABLE"),
		"properties": obj{"name": s.Name, "listenerLan": listener.id, "ips": []any{pub}, "targetLan": target.id,
			"lbPrivateIps": []any{target.sub.host() + "/24"}, "centralLogging": false, "loggingFormat": nil},
		"entities": obj{
			"forwardingrules": g.entityCollection(href+"/forwardingrules", []any{rule}),
			"flowlogs":        g.entityCollection(href+"/flowlogs", []any{}),
		},
	})
}

func (g *gen) buildALB(d *dc, s *lbSpec) {
	listener, target, targets := g.lbLANs(d, s)
	tgID := g.uuid()
	ts := []any{}
	for _, ip := range targets {
		ts = append(ts, obj{"ip": ip, "port": 8080, "weight": 1, "healthCheckEnabled": true, "maintenanceEnabled": false})
	}
	g.targetGroups = append(g.targetGroups, obj{
		"id": tgID, "type": "target-group", "href": cloudBase + "/targetgroups/" + tgID, "metadata": g.meta("AVAILABLE"),
		"properties": obj{"name": s.Name + "-" + s.TargetRole, "algorithm": "ROUND_ROBIN", "protocol": "HTTP", "protocolVersion": "HTTP1",
			"targets":         ts,
			"healthCheck":     obj{"checkTimeout": 2000, "checkInterval": 2000, "retries": 3},
			"httpHealthCheck": obj{"path": "/healthz", "method": "GET", "matchType": "STATUS_CODE", "response": "200", "regex": false, "negate": false}},
	})

	id := g.uuid()
	href := fmt.Sprintf("%s/datacenters/%s/applicationloadbalancers/%s", cloudBase, d.id, id)
	pub := g.publicIP(d, obj{})
	g.lbIPs[s.Name] = pub
	rid := g.uuid()
	rule := obj{
		"id": rid, "type": "forwarding-rule", "href": href + "/forwardingrules/" + rid, "metadata": g.meta("AVAILABLE"),
		"properties": obj{"name": "https", "protocol": "HTTP", "listenerIp": pub, "listenerPort": s.Port,
			"clientTimeout": 50000, "serverCertificates": []any{g.uuid()},
			"httpRules": []any{obj{"name": "to-" + s.TargetRole, "type": "FORWARD", "targetGroup": tgID, "conditions": []any{}}}},
	}
	// The Certificate Manager lists this certificate (services.go).
	g.albCerts[s.Name] = rule["properties"].(obj)["serverCertificates"].([]any)[0].(string)
	d.albs = append(d.albs, obj{
		"id": id, "type": "applicationloadbalancer", "href": href, "metadata": g.meta("AVAILABLE"),
		"properties": obj{"name": s.Name, "listenerLan": listener.id, "ips": []any{pub}, "targetLan": target.id,
			"lbPrivateIps": []any{target.sub.host() + "/24"}, "centralLogging": false, "loggingFormat": nil},
		"entities": obj{
			"forwardingrules": g.entityCollection(href+"/forwardingrules", []any{rule}),
			"flowlogs":        g.entityCollection(href+"/flowlogs", []any{}),
		},
	})
}

// --- managed services ----------------------------------------------------------

func (g *gen) buildNodePool(d *dc, s nodePoolSpec) {
	c := g.clusters[s.Cluster]
	if c == nil {
		c = &k8sCluster{id: g.uuid(), name: s.Cluster, version: g.pick("1.30.6", "1.31.2")}
		g.clusters[s.Cluster] = c
		g.clusterOrder = append(g.clusterOrder, c)
	}
	lans := []any{}
	for _, key := range s.LANs {
		lans = append(lans, obj{"id": d.lans[key].id, "dhcp": true, "routes": []any{}})
	}
	id := g.uuid()
	c.pools = append(c.pools, obj{
		"id": id, "type": "nodepool", "href": fmt.Sprintf("%s/k8s/%s/nodepools/%s", cloudBase, c.id, id),
		"metadata": g.meta("ACTIVE"),
		"properties": obj{
			"name": s.Name, "datacenterId": d.id, "nodeCount": s.Nodes,
			"cpuFamily": cpuFamilies[d.spec.Location], "serverType": "DedicatedCore",
			"coresCount": s.Cores, "ramSize": s.RAM, "availabilityZone": "AUTO",
			"storageType": "SSD", "storageSize": 100, "k8sVersion": c.version,
			"maintenanceWindow": obj{"dayOfTheWeek": "Sunday", "time": "02:00:00Z"},
			"autoScaling":       obj{"minNodeCount": s.Nodes, "maxNodeCount": s.Nodes * 2},
			"lans":              lans, "labels": obj{}, "annotations": obj{}, "publicIps": []any{},
		},
	})
}

func (g *gen) buildPostgres(d *dc, s pgSpec) {
	l := d.lans[s.LAN]
	id := g.uuid()
	region := strings.ReplaceAll(d.spec.Location, "/", "-")
	m := g.meta("AVAILABLE")
	delete(m, "etag")
	m["dnsName"] = fmt.Sprintf("pg-%s.postgresql.%s.ionos.com", id[:8], region)
	// PostgreSQL v2: one connection, sizes per instance in GB, and the
	// location only in the regional host the cluster is listed on.
	g.postgres[region] = append(g.postgres[region], obj{
		"id": id, "type": "cluster", "href": "https://postgresql." + region + ".ionos.com/clusters/" + id, "metadata": m,
		"properties": obj{
			"name": s.Name, "description": "", "version": s.Version,
			"instances":         obj{"count": s.Instances, "cores": 4, "ram": 16, "storageSize": 200},
			"connection":        obj{"datacenterId": d.id, "lanId": strconv.Itoa(l.id), "primaryInstanceAddress": l.sub.host() + "/24"},
			"maintenanceWindow": obj{"dayOfTheWeek": "Sunday", "time": "03:00:00"},
			"replicationMode":   "ASYNCHRONOUS", "connectionPooler": "DISABLED",
			"logsEnabled": true, "metricsEnabled": true,
			"backup": obj{"location": "eu-central-3", "retentionDays": 7},
		},
	})
}

// --- VPN gateways ------------------------------------------------------------------

func (g *gen) buildVPN(s vpnSpec) {
	var d *dc
	for _, c := range g.dcs {
		if c.spec.Name == s.DC {
			d = c
		}
	}
	if d == nil || d.lans[s.LAN] == nil || d.lans[s.LAN].sub == nil {
		panic("vpn " + s.Name + ": unknown datacenter or private LAN")
	}
	l := d.lans[s.LAN]
	region := strings.Join(strings.Split(d.spec.Location, "/")[:2], "-")
	base := "https://vpn." + region + ".ionos.com"
	id := g.uuid()
	coll := "ipsecgateways"
	if s.Kind == "wireguard" {
		coll = "wireguardgateways"
	}
	href := base + "/" + coll + "/" + id
	childHref := href + "/tunnels/"
	if s.Kind == "wireguard" {
		childHref = href + "/peers/"
	}
	props := obj{
		"name": s.Name, "description": s.Description,
		"gatewayIP":         g.publicIP(d, obj{}),
		"connections":       []any{obj{"datacenterId": d.id, "lanId": strconv.Itoa(l.id), "ipv4CIDR": l.sub.host() + "/24"}},
		"tier":              "STANDARD",
		"maintenanceWindow": obj{"dayOfTheWeek": "Monday", "time": "02:00:00"},
	}
	var children []any
	for _, t := range s.Tunnels {
		remote := t.Remote
		if ip, ok := g.serverIPs[remote]; ok {
			remote = ip
		} else if remote != "" && !strings.HasPrefix(remote, "192.0.2.") {
			panic("vpn " + s.Name + ": unknown server " + remote)
		}
		cid := g.uuid()
		var tp obj
		var typ string
		if s.Kind == "wireguard" {
			typ = "wireguardpeer"
			tp = obj{"name": t.Name, "description": t.Description, "allowedIPs": strs(t.Networks), "publicKey": g.wgKey()}
			if remote != "" {
				tp["endpoint"] = obj{"host": remote, "port": t.Port}
			}
		} else {
			typ = "ipsectunnel"
			tp = obj{
				"name": t.Name, "description": t.Description, "remoteHost": remote,
				"auth":              obj{"method": "PSK"},
				"ike":               obj{"diffieHellmanGroup": "16-MODP4096", "encryptionAlgorithm": "AES256", "integrityAlgorithm": "SHA256", "lifetime": 86400},
				"esp":               obj{"diffieHellmanGroup": "16-MODP4096", "encryptionAlgorithm": "AES256", "integrityAlgorithm": "SHA256", "lifetime": 3600},
				"cloudNetworkCIDRs": []any{l.sub.base + ".0/24"},
				"peerNetworkCIDRs":  strs(t.Networks),
			}
		}
		children = append(children, obj{"id": cid, "type": typ, "href": childHref + cid, "metadata": g.vpnMeta(), "properties": tp})
	}
	if s.Kind == "wireguard" {
		props["interfaceIPv4CIDR"] = "192.168.77.1/24"
		props["listenPort"] = 51820
		props["publicKey"] = g.wgKey()
	} else {
		props["version"] = "IKEv2"
	}
	if g.vpn[region] == nil {
		g.vpn[region] = map[string][]any{}
	}
	g.vpn[region][s.Kind] = append(g.vpn[region][s.Kind], obj{"id": id, "type": strings.TrimSuffix(coll, "s"), "href": href, "metadata": g.vpnMeta(), "properties": props})
	g.vpnChildren[id] = children
}

// vpnMeta is the metadata shape of the VPN Gateway API (status, not state).
func (g *gen) vpnMeta() obj {
	m := g.meta("AVAILABLE")
	delete(m, "etag")
	delete(m, "state")
	m["status"] = "AVAILABLE"
	return m
}

func (g *gen) wgKey() string {
	b := make([]byte, 32)
	for i := range b {
		b[i] = byte(g.rng.Intn(256))
	}
	return base64.StdEncoding.EncodeToString(b)
}

func strs(list []string) []any {
	out := make([]any, len(list))
	for i, s := range list {
		out[i] = s
	}
	return out
}

// --- IP management -------------------------------------------------------------

var blockSizes = map[string]int{"de/fra": 16, "de/txl": 8, "gb/lhr": 8}

// publicIP takes the next free address from a reserved IP block in the
// datacenter's location and records the consumer the way /ipblocks reports it.
func (g *gen) publicIP(d *dc, consumer obj) string {
	loc := d.spec.Location
	var b *ipBlock
	for _, cand := range g.blocks {
		if cand.location == loc && cand.used < len(cand.ips) && !strings.HasSuffix(cand.name, "-reserve") {
			b = cand
			break
		}
	}
	if b == nil {
		size := blockSizes[loc]
		if size == 0 {
			size = 4
		}
		n := 1
		for _, cand := range g.blocks {
			if cand.location == loc {
				n++
			}
		}
		b = g.newBlock(loc, fmt.Sprintf("ipb-%s-%d", strings.ReplaceAll(loc, "/", "-"), n), size)
	}
	ip := b.ips[b.used]
	b.used++
	c := obj{"ip": ip, "datacenterId": d.id, "datacenterName": d.spec.Name}
	for k, v := range consumer {
		c[k] = v
	}
	b.consumers = append(b.consumers, c)
	return ip
}

func (g *gen) newBlock(loc, name string, size int) *ipBlock {
	if len(g.publicPool) < size {
		panic("public IP pool exhausted")
	}
	b := &ipBlock{id: g.uuid(), name: name, location: loc, ips: g.publicPool[:size]}
	g.publicPool = g.publicPool[size:]
	g.blocks = append(g.blocks, b)
	return b
}

func (g *gen) newSubnet() *subnet {
	for {
		base := fmt.Sprintf("10.%d.%d", 1+g.rng.Intn(254), g.rng.Intn(255))
		if !g.subnets[base] {
			g.subnets[base] = true
			return &subnet{base: base, next: 10}
		}
	}
}

// --- output ----------------------------------------------------------------------

func (g *gen) emitAll() {
	dcItems := []any{}
	for _, d := range g.dcs {
		dcItems = append(dcItems, g.dcObject(d))
		base := "/datacenters/" + d.id
		g.emit(cloudAPI, "/datacenters/{datacenterId}/servers", base+"/servers", "depth=5", g.collection(base+"/servers", d.servers))
		sgs := []any{}
		for _, sg := range d.sgs {
			sgs = append(sgs, sg.obj)
		}
		g.emit(cloudAPI, "/datacenters/{datacenterId}/securitygroups", base+"/securitygroups", "depth=3", g.collection(base+"/securitygroups", sgs))
		g.emit(cloudAPI, "/datacenters/{datacenterId}/volumes", base+"/volumes", "depth=1", g.collection(base+"/volumes", d.volumes))
		g.emit(cloudAPI, "/datacenters/{datacenterId}/lans", base+"/lans", "depth=1", g.collection(base+"/lans", g.lanItems(d)))
		g.emit(cloudAPI, "/datacenters/{datacenterId}/natgateways", base+"/natgateways", "depth=3", g.collection(base+"/natgateways", d.nats))
		g.emit(cloudAPI, "/datacenters/{datacenterId}/networkloadbalancers", base+"/networkloadbalancers", "depth=3", g.collection(base+"/networkloadbalancers", d.nlbs))
		g.emit(cloudAPI, "/datacenters/{datacenterId}/applicationloadbalancers", base+"/applicationloadbalancers", "depth=3", g.collection(base+"/applicationloadbalancers", d.albs))
	}
	g.emit(cloudAPI, "/datacenters", "/datacenters", "depth=1", g.collection("/datacenters", dcItems))

	pccItems := []any{}
	for _, c := range g.pccOrder {
		connectable := []any{}
		if len(c.peers) > 0 {
			loc := c.peers[0].(obj)["location"]
			for _, d := range g.dcs {
				if d.spec.Location == loc {
					connectable = append(connectable, obj{"id": d.id, "name": d.spec.Name, "location": d.spec.Location})
				}
			}
		}
		pccItems = append(pccItems, obj{
			"id": c.id, "type": "pcc", "href": cloudBase + "/pccs/" + c.id, "metadata": g.meta("AVAILABLE"),
			"properties": obj{"name": c.name, "description": c.desc, "peers": c.peers, "connectableDatacenters": connectable},
		})
	}
	g.emit(cloudAPI, "/pccs", "/pccs", "depth=1", g.collection("/pccs", pccItems))

	blockItems := []any{}
	reserved, inUse := 0, 0
	for _, b := range g.blocks {
		ips := make([]any, len(b.ips))
		for i, ip := range b.ips {
			ips[i] = ip
		}
		reserved += len(b.ips)
		inUse += b.used
		consumers := b.consumers
		if consumers == nil {
			consumers = []any{}
		}
		blockItems = append(blockItems, obj{
			"id": b.id, "type": "ipblock", "href": cloudBase + "/ipblocks/" + b.id, "metadata": g.meta("AVAILABLE"),
			"properties": obj{"name": b.name, "location": b.location, "size": len(b.ips), "ips": ips, "ipConsumers": consumers},
		})
	}
	g.emit(cloudAPI, "/ipblocks", "/ipblocks", "depth=1", g.collection("/ipblocks", blockItems))
	g.emit(cloudAPI, "/targetgroups", "/targetgroups", "depth=1", g.collection("/targetgroups", g.targetGroups))
	g.emit(cloudAPI, "/images", "/images", "depth=1", g.collection("/images", g.imageList))
	g.emit(cloudAPI, "/templates", "/templates", "depth=1", g.collection("/templates", g.templateList))

	clusterItems := []any{}
	for _, c := range g.clusterOrder {
		clusterItems = append(clusterItems, obj{
			"id": c.id, "type": "k8s", "href": cloudBase + "/k8s/" + c.id, "metadata": g.meta("ACTIVE"),
			"properties": obj{"name": c.name, "k8sVersion": c.version, "public": true,
				"maintenanceWindow":        obj{"dayOfTheWeek": "Saturday", "time": "23:00:00Z"},
				"availableUpgradeVersions": []any{}, "viableNodePoolVersions": []any{c.version},
				"apiSubnetAllowList": []any{officeIP}, "s3Buckets": []any{}},
		})
		p := "/k8s/" + c.id + "/nodepools"
		g.emit(cloudAPI, "/k8s/{k8sClusterId}/nodepools", p, "depth=1", g.collection(p, c.pools))
	}
	g.emit(cloudAPI, "/k8s", "/k8s", "depth=1", g.collection("/k8s", clusterItems))

	g.emit(cloudAPI, "/labels", "/labels", "depth=1", g.collection("/labels", g.labels))
	g.emit(cloudAPI, "/contracts", "/contracts", "", g.collection("/contracts", []any{g.contract(reserved, inUse)}))

	// A read-only, non-admin user cannot list users or groups. The real
	// exporter records this rather than failing; the fixture does the same.
	for _, p := range []string{"/um/users", "/um/groups"} {
		g.w.AddCoverage(snapshot.Coverage{
			API: cloudAPI, Endpoint: p, Path: p, Query: "depth=1",
			Status: snapshot.StatusForbidden, HTTPStatus: 403,
			Error: "[VDC-14-1] Access denied: user management requires administrator privileges",
		})
	}

	for _, region := range endpoints.VPNRegions {
		api, base := endpoints.VPNAPI(region), "https://vpn."+region+".ionos.com"
		for _, kind := range []string{"ipsec", "wireguard"} {
			coll, child, param := "/ipsecgateways", "tunnels", "{gatewayId}"
			if kind == "wireguard" {
				coll, child = "/wireguardgateways", "peers"
			}
			gws := g.vpn[region][kind]
			g.emit(api, coll, coll, "", vpnCollection(base+coll, gws))
			for _, gw := range gws {
				id := gw.(obj)["id"].(string)
				p := coll + "/" + id + "/" + child
				g.emit(api, coll+"/"+param+"/"+child, p, "", vpnCollection(base+p, g.vpnChildren[id]))
			}
		}
	}

	for _, region := range endpoints.PostgresRegions {
		clusters := g.postgres[region]
		g.emit(endpoints.PostgresAPI(region), "/clusters", "/clusters", "", obj{
			"id": "clusters", "type": "collection", "href": "https://postgresql." + region + ".ionos.com/clusters",
			"items": nonNil(clusters), "offset": 0, "limit": len(clusters), "_links": obj{},
		})
	}
	g.emitServices()
}

func (g *gen) dcObject(d *dc) obj {
	cpu := cpuFamilies[d.spec.Location]
	vendor := "GenuineIntel"
	if strings.HasPrefix(cpu, "AMD") {
		vendor = "AuthenticAMD"
	}
	return obj{
		"id": d.id, "type": "datacenter", "href": cloudBase + "/datacenters/" + d.id, "metadata": g.meta("AVAILABLE"),
		"properties": obj{
			"name": d.spec.Name, "description": d.spec.Description, "location": d.spec.Location,
			"version": 5 + g.rng.Intn(300), "secAuthProtection": false, "ipv6CidrBlock": nil,
			"features":        []any{"SSD", "cloud-init", "vnf-nat", "vnf-lb", "vnf-alb", "k8s", "pcc", "flow-logs"},
			"cpuArchitecture": []any{obj{"cpuFamily": cpu, "maxCores": 62, "maxRam": 245760, "vendor": vendor}},
		},
	}
}

func (g *gen) lanItems(d *dc) []any {
	items := []any{}
	for _, l := range d.order {
		var pccID any
		if l.pcc != nil {
			pccID = l.pcc.id
		}
		items = append(items, obj{
			"id": strconv.Itoa(l.id), "type": "lan", "href": fmt.Sprintf("%s/datacenters/%s/lans/%d", cloudBase, d.id, l.id),
			"metadata": g.meta("AVAILABLE"),
			"properties": obj{"name": l.spec.Name, "public": l.spec.Public, "pcc": pccID,
				"ipFailover": l.failover, "ipv6CidrBlock": nil},
		})
	}
	return items
}

func (g *gen) contract(reserved, inUse int) obj {
	return obj{
		"type": "contract",
		"properties": obj{
			"contractNumber": contractNumber, "owner": "cloud-admins@example.com", "status": "BILLABLE", "regDomain": "ionos.de",
			"resourceLimits": obj{
				"coresPerServer": 62, "coresPerContract": 1200, "coresProvisioned": g.totals.cores,
				"ramPerServer": 245760, "ramPerContract": 4194304, "ramProvisioned": g.totals.ram,
				"hddLimitPerVolume": 4194304, "hddLimitPerContract": 41943040, "hddVolumeProvisioned": g.totals.hddGB * 1024,
				"ssdLimitPerVolume": 4194304, "ssdLimitPerContract": 41943040, "ssdVolumeProvisioned": g.totals.ssdGB * 1024,
				"dasVolumeProvisioned": g.totals.dasGB * 1024,
				"reservableIps":        128, "reservedIpsOnContract": reserved, "reservedIpsInUse": inUse,
				"k8sClusterLimitTotal": 10, "k8sClustersProvisioned": len(g.clusterOrder),
				"nlbLimitTotal": 10, "nlbProvisioned": g.totals.nlb,
				"natGatewayLimitTotal": 10, "natGatewayProvisioned": g.totals.nat,
			},
		},
	}
}

func (g *gen) emit(api, endpoint, path, query string, doc obj) {
	file := snapshot.RawFile(api, path)
	if err := g.w.AddJSON(file, doc); err != nil {
		panic(err)
	}
	n := len(doc["items"].([]any))
	g.w.AddCoverage(snapshot.Coverage{
		API: api, Endpoint: endpoint, Path: path, Query: query,
		Status: snapshot.StatusOK, HTTPStatus: 200, File: file, Items: &n, Pages: 1,
	})
}

// collection mimics a top-level Cloud API list response after the exporter
// has merged all pages (offset 0, limit = item count, no links).
func (g *gen) collection(path string, items []any) obj {
	return obj{
		"id": strings.TrimPrefix(strings.ReplaceAll(path, "/", "-"), "-"), "type": "collection", "href": cloudBase + path,
		"items": nonNil(items), "offset": 0, "limit": len(nonNil(items)), "_links": obj{},
	}
}

// vpnCollection mimics a VPN Gateway API list after merging pages.
func vpnCollection(href string, items []any) obj {
	return obj{"id": href[strings.LastIndex(href, "/")+1:], "type": "collection", "href": href,
		"items": nonNil(items), "offset": 0, "limit": len(nonNil(items)), "_links": obj{}}
}

// entityCollection mimics a collection embedded in a parent via ?depth.
func (g *gen) entityCollection(href string, items []any) obj {
	return obj{"id": href[strings.LastIndex(href, "/")+1:], "type": "collection", "href": href, "items": nonNil(items)}
}

func (g *gen) label(rtype, rid, rhref, key, value string) {
	id := fmt.Sprintf("urn:label:%s:%s:%s", rtype, rid, key)
	g.labels = append(g.labels, obj{
		"id": id, "type": "label", "href": cloudBase + "/labels/" + id,
		"properties": obj{"key": key, "value": value, "resourceId": rid, "resourceType": rtype, "resourceHref": rhref},
	})
}

// --- random helpers ----------------------------------------------------------

func (g *gen) meta(state string) obj {
	start := time.Date(2021, 3, 1, 0, 0, 0, 0, time.UTC)
	created := g.between(start, g.now.Add(-60*24*time.Hour))
	modified := g.between(created, g.now.Add(-time.Hour))
	cu, mu := g.users[g.rng.Intn(len(g.users))], g.users[g.rng.Intn(len(g.users))]
	return obj{
		"etag":        g.hex(16),
		"createdDate": created.Format(time.RFC3339), "createdBy": cu.email, "createdByUserId": cu.id,
		"lastModifiedDate": modified.Format(time.RFC3339), "lastModifiedBy": mu.email, "lastModifiedByUserId": mu.id,
		"state": state,
	}
}

func (g *gen) between(a, b time.Time) time.Time {
	return a.Add(time.Duration(g.rng.Int63n(int64(b.Sub(a))))).Truncate(time.Second)
}

func (g *gen) uuid() string {
	var b [16]byte
	g.rng.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func (g *gen) mac() string {
	var b [4]byte
	g.rng.Read(b[:])
	return fmt.Sprintf("02:01:%02x:%02x:%02x:%02x", b[0], b[1], b[2], b[3])
}

func (g *gen) hex(n int) string {
	b := make([]byte, n)
	g.rng.Read(b)
	return fmt.Sprintf("%x", b)
}

func (g *gen) pick(options ...string) string { return options[g.rng.Intn(len(options))] }

func nonNil(items []any) []any {
	if items == nil {
		return []any{}
	}
	return items
}
