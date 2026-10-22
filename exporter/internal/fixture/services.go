package fixture

import (
	"fmt"
	"math/rand"
	"strconv"
	"strings"
	"time"

	"github.com/K4ugummi/ionos-explorer/exporter/internal/endpoints"
)

// The products beyond the Cloud API, PostgreSQL and VPN: DNS, the other
// databases, Kafka, file storage, certificates, CDN, logging and
// monitoring, the container registry, auto scaling, plus backup units and
// volume snapshots of the Cloud API. They draw from a random source of
// their own, so the rest of the demo contract is the same as without them.

const (
	shopZone = "shop.example.com"
	corpZone = "corp.example.net"
	// Where the CDN answers (documentation ranges, outside the contract's IPs).
	cdnIPv4 = "198.51.100.240"
	cdnIPv6 = "2001:db8:cd::1"
)

type services struct {
	mariadb    map[string][]any // region -> clusters
	inmemorydb map[string][]any
	kafka      map[string][]any
	nfs        map[string][]any
	logging    map[string][]any
	monitoring map[string][]any
	children   map[string][]any // cluster or registry or group id -> topics, shares, repositories, servers
	mongo      []any
	zones      []any
	records    []any
	secondary  []any
	reverse    []any
	certs      []any
	autoCerts  []any
	cdn        []any
	registries []any
	groups     []any
	backups    []any
	snapshots  []any
}

func (g *gen) buildServices() {
	main := g.rng
	g.rng = rand.New(rand.NewSource(g.seed + 7919))
	defer func() { g.rng = main }()
	g.services = &services{
		mariadb: map[string][]any{}, inmemorydb: map[string][]any{}, kafka: map[string][]any{}, nfs: map[string][]any{},
		logging: map[string][]any{}, monitoring: map[string][]any{}, children: map[string][]any{},
	}
	s := g.services

	g.mariaDB("fra-prod-data", "db", "mariadb-shop", "10.11", 3)
	g.mariaDB("txl-prod-erp", "db", "mariadb-erp-reports", "10.6", 1)
	g.inMemoryDB("fra-prod-shop", "web", "redis-sessions")
	g.mongoDB("fra-prod-data", "db", "mongo-catalog")
	g.kafkaCluster("fra-prod-data", "k8s", "kafka-events")
	g.fileStorage("fra-mgmt", "tools", "nfs-tools")
	g.pipelines("de-fra")
	g.registry("de/fra", "shopregistry")
	g.autoscaling("fra-prod-shop", "web", "shop-web-scale", []string{"shop-web-11", "shop-web-12"})
	g.certificates()
	g.distribution()
	g.dns()

	s.backups = append(s.backups, g.cloudItem("backupunit", "/backupunits/", obj{"name": "backup-erp", "email": "backup-team@example.com"}))
	for _, v := range []struct {
		name, location, description string
		size                        int
	}{
		{"erp-db-01-before-upgrade", "de/txl", "Taken before the SQL Server upgrade", 2000},
		{"fra-core-fw-01-pre-patch", "de/fra", "", 20},
	} {
		s.snapshots = append(s.snapshots, g.cloudItem("snapshot", "/snapshots/", obj{
			"name": v.name, "description": v.description, "location": v.location, "size": v.size,
			"licenceType": "LINUX", "secAuthProtection": false, "cpuHotPlug": true, "ramHotPlug": true, "nicHotPlug": true,
			"discVirtioHotPlug": true, "exposeSerial": false, "requireLegacyBios": true,
		}))
	}
}

// cloudItem is an item of a Cloud API collection.
func (g *gen) cloudItem(typ, path string, props obj) obj {
	id := g.uuid()
	return obj{"id": id, "type": typ, "href": cloudBase + path + id, "metadata": g.meta("AVAILABLE"), "properties": props}
}

// svcMeta is the metadata of the newer APIs: no etag, the state as `field` (state or status).
func (g *gen) svcMeta(field, state string) obj {
	m := g.meta(state)
	delete(m, "etag")
	if field != "state" {
		delete(m, "state")
		m[field] = state
	}
	return m
}

func (g *gen) dcByName(name string) *dc {
	for _, d := range g.dcs {
		if d.spec.Name == name {
			return d
		}
	}
	panic("services: unknown datacenter " + name)
}

func (g *gen) privateLAN(dcName, key string) (*dc, *lan) {
	d := g.dcByName(dcName)
	l := d.lans[key]
	if l == nil || l.sub == nil {
		panic("services: no private LAN " + key + " in " + dcName)
	}
	return d, l
}

func region(location string) string { return strings.Join(strings.Split(location, "/")[:2], "-") }

func (g *gen) mariaDB(dcName, lanKey, name, version string, instances int) {
	d, l := g.privateLAN(dcName, lanKey)
	r := region(d.spec.Location)
	id := g.uuid()
	m := g.svcMeta("state", "AVAILABLE")
	m["dnsName"] = fmt.Sprintf("ma-%s.mariadb.%s.ionos.com", id[:8], r)
	g.services.mariadb[r] = append(g.services.mariadb[r], obj{
		"id": id, "type": "cluster", "href": "https://mariadb." + r + ".ionos.com/v2/clusters/" + id, "metadata": m,
		"properties": obj{
			"name": name, "description": "", "version": version,
			"instances":         obj{"count": instances, "cores": 4, "ram": 16, "storageSize": 100},
			"connection":        obj{"datacenterId": d.id, "lanId": strconv.Itoa(l.id), "primaryInstanceAddress": l.sub.host() + "/24"},
			"maintenanceWindow": obj{"dayOfTheWeek": "Sunday", "time": "04:00:00"},
			"credentials":       obj{"username": "dbadmin", "database": strings.ReplaceAll(name, "-", "_")},
			"backup":            obj{"location": "de", "retentionDays": 7},
			"logsEnabled":       true, "metricsEnabled": true,
		},
	})
}

func (g *gen) inMemoryDB(dcName, lanKey, name string) {
	d, l := g.privateLAN(dcName, lanKey)
	r := region(d.spec.Location)
	id := g.uuid()
	m := g.svcMeta("state", "AVAILABLE")
	m["dnsName"] = fmt.Sprintf("%s.in-memory-db.%s.ionos.com", id, r)
	g.services.inmemorydb[r] = append(g.services.inmemorydb[r], obj{
		"id": id, "type": "cluster", "href": "https://in-memory-db." + r + ".ionos.com/v2/clusters/" + id, "metadata": m,
		"properties": obj{
			"name": name, "description": "Shop sessions and carts", "version": "7.2",
			"instances":       obj{"count": 3, "cores": 2, "ram": 8},
			"connection":      obj{"datacenterId": d.id, "lanId": strconv.Itoa(l.id), "primaryInstanceAddress": l.sub.host() + "/24"},
			"persistenceMode": "RDB", "evictionPolicy": "allkeys-lru",
			"snapshot":          obj{"location": "de", "retentionDays": 3, "snapshotHours": []any{2, 14}},
			"maintenanceWindow": obj{"dayOfTheWeek": "Tuesday", "time": "03:00:00"},
			"credentials":       obj{"username": "shop"},
			"logsEnabled":       true, "metricsEnabled": true,
		},
	})
}

func (g *gen) mongoDB(dcName, lanKey, name string) {
	d, l := g.privateLAN(dcName, lanKey)
	id := g.uuid()
	cidrs := []any{l.sub.host() + "/24", l.sub.host() + "/24", l.sub.host() + "/24"}
	m := g.svcMeta("state", "AVAILABLE")
	m["health"] = "HEALTHY"
	g.services.mongo = append(g.services.mongo, obj{
		"id": id, "type": "cluster", "metadata": m,
		"properties": obj{
			"type": "replicaset", "displayName": name, "mongoDBVersion": "7.0", "location": d.spec.Location,
			"instances": 3, "shards": 0, "edition": "business", "templateID": g.uuid(),
			"connections":       []any{obj{"datacenterId": d.id, "lanId": strconv.Itoa(l.id), "cidrList": cidrs}},
			"connectionString":  fmt.Sprintf("mongodb+srv://m-%s.mongodb.%s.ionos.com", id[:8], region(d.spec.Location)),
			"maintenanceWindow": obj{"dayOfTheWeek": "Saturday", "time": "02:00:00"},
			"backup":            obj{"location": "de"},
			"biConnector":       obj{"enabled": false},
		},
	})
}

func (g *gen) kafkaCluster(dcName, lanKey, name string) {
	d, l := g.privateLAN(dcName, lanKey)
	r := region(d.spec.Location)
	id := g.uuid()
	var cidrs, brokers []any
	for range 3 {
		ip := l.sub.host()
		cidrs = append(cidrs, ip+"/24")
		brokers = append(brokers, ip+":9093")
	}
	m := g.svcMeta("state", "AVAILABLE")
	m["message"] = "In service"
	m["brokerAddresses"] = brokers
	href := "https://kafka." + r + ".ionos.com/clusters/" + id
	g.services.kafka[r] = append(g.services.kafka[r], obj{
		"id": id, "type": "cluster", "href": href, "metadata": m,
		"properties": obj{
			"name": name, "version": "3.9.0", "size": "S",
			"connections": []any{obj{"datacenterId": d.id, "lanId": strconv.Itoa(l.id), "brokerAddresses": cidrs}},
		},
	})
	for _, t := range []struct {
		name                string
		partitions, retainH int
	}{{"orders", 12, 168}, {"payments", 6, 168}, {"audit-log", 3, 720}} {
		tid := g.uuid()
		g.services.children[id] = append(g.services.children[id], obj{
			"id": tid, "type": "topic", "href": href + "/topics/" + tid,
			"metadata": obj{"state": "AVAILABLE", "message": "In service"},
			"properties": obj{"name": t.name, "replicationFactor": 3, "numberOfPartitions": t.partitions,
				"logRetention": obj{"retentionTime": t.retainH * 3600 * 1000, "segmentBytes": 1073741824}},
		})
	}
}

func (g *gen) fileStorage(dcName, lanKey, name string) {
	d, l := g.privateLAN(dcName, lanKey)
	r := region(d.spec.Location)
	id := g.uuid()
	m := g.svcMeta("status", "AVAILABLE")
	m["used"] = 412316860416
	href := "https://nfs." + r + ".ionos.com/clusters/" + id
	g.services.nfs[r] = append(g.services.nfs[r], obj{
		"id": id, "type": "cluster", "href": href, "metadata": m,
		"properties": obj{
			"name": name, "size": 2, "sizeUnit": "TiB", "nfs": obj{"minVersion": "4.2"},
			"connections": []any{obj{"datacenterId": d.id, "lan": strconv.Itoa(l.id), "ipAddress": l.sub.host() + "/24"}},
		},
	})
	for _, sh := range []struct {
		name, who, squash string
		quota             int
	}{{"ci-cache", "GitLab runners", "root-anonymous", 0}, {"monitoring-archive", "Monitoring servers", "none", 512000}} {
		sid := g.uuid()
		sm := g.svcMeta("status", "AVAILABLE")
		sm["nfsPath"] = "/" + sid
		sm["used"] = 1 + g.rng.Intn(100_000_000_000)
		g.services.children[id] = append(g.services.children[id], obj{
			"id": sid, "type": "share", "href": href + "/shares/" + sid, "metadata": sm,
			"properties": obj{"name": sh.name, "quota": sh.quota, "gid": 1000, "uid": 1000,
				"clientGroups": []any{obj{"description": sh.who, "ipNetworks": []any{l.sub.base + ".0/24"}, "hosts": []any{},
					"nfs": obj{"squash": sh.squash}}}},
		})
	}
}

func (g *gen) pipelines(r string) {
	id := g.uuid()
	g.services.logging[r] = append(g.services.logging[r], obj{
		"id": id, "type": "pipeline", "href": "https://logging." + r + ".ionos.com/pipelines/" + id,
		"metadata": g.svcMeta("state", "AVAILABLE"),
		"properties": obj{
			"name": "prod-logs",
			"logs": []any{
				obj{"source": "kubernetes", "tag": "k8s-prod-fra", "protocol": "http", "labels": []any{},
					"destinations": []any{obj{"type": "loki", "retentionInDays": 30}}},
				obj{"source": "systemd", "tag": "vms", "protocol": "tcp", "labels": []any{"env=prod"},
					"destinations": []any{obj{"type": "loki", "retentionInDays": 14}}},
			},
			"tcpAddress":     fmt.Sprintf("tcp-%s.logging.%s.ionos.com:9000", id[:8], r),
			"httpAddress":    fmt.Sprintf("https://%s.logging.%s.ionos.com", id[:8], r),
			"grafanaAddress": fmt.Sprintf("https://grafana-%s.logging.%s.ionos.com", id[:8], r),
			"resourceTier":   "M",
		},
	})
	id = g.uuid()
	m := g.svcMeta("state", "AVAILABLE")
	m["grafanaEndpoint"] = fmt.Sprintf("https://grafana-%s.monitoring.%s.ionos.com", id[:8], r)
	m["httpEndpoint"] = fmt.Sprintf("https://%s.monitoring.%s.ionos.com", id[:8], r)
	g.services.monitoring[r] = append(g.services.monitoring[r], obj{
		"id": id, "type": "pipeline", "href": "https://monitoring." + r + ".ionos.com/pipelines/" + id,
		"metadata": m, "properties": obj{"name": "prod-metrics"},
	})
}

func (g *gen) registry(location, name string) {
	id := g.uuid()
	host := fmt.Sprintf("%s-%s.cr.%s.ionos.com", name, g.hex(3), region(location))
	m := g.svcMeta("state", "Running")
	g.services.registries = append(g.services.registries, obj{
		"id": id, "type": "registry", "href": "https://api.ionos.com/containerregistries/registries/" + id, "metadata": m,
		"properties": obj{
			"name": name, "location": location, "hostname": host,
			"garbageCollectionSchedule": obj{"days": []any{"Sunday"}, "time": "01:00:00+00:00"},
			"storageUsage":              obj{"bytes": 18253611008, "updatedAt": g.now.Add(-3 * time.Hour).Format(time.RFC3339)},
			"features":                  obj{"vulnerabilityScanning": obj{"enabled": true}},
			"apiSubnetAllowList":        []any{officeIP},
		},
	})
	for i, repo := range []string{"shop/web", "shop/api", "tools/gitlab-runner"} {
		rid := g.uuid()
		pushed := g.now.Add(-time.Duration(2+i*30) * time.Hour)
		g.services.children[id] = append(g.services.children[id], obj{
			"id": rid, "type": "repository", "href": "https://api.ionos.com/containerregistries/registries/" + id + "/repositories/" + rid,
			"metadata": obj{"artifactCount": 12 - 3*i, "pullCount": 4000 - 1000*i, "pushCount": 120 - 30*i,
				"lastPushedAt": pushed.Format(time.RFC3339), "lastPulledAt": pushed.Add(time.Hour).Format(time.RFC3339),
				"lastSeverity": []string{"low", "medium", "high"}[i]},
			"properties": obj{"name": repo},
		})
	}
}

func (g *gen) autoscaling(dcName, lanKey, name string, servers []string) {
	d, l := g.privateLAN(dcName, lanKey)
	id := g.uuid()
	href := "https://api.ionos.com/autoscaling/groups/" + id
	g.services.groups = append(g.services.groups, obj{
		"id": id, "type": "autoscaling-group", "href": href, "metadata": g.svcMeta("state", "AVAILABLE"),
		"properties": obj{
			"name": name, "location": d.spec.Location,
			"datacenter":      obj{"id": d.id, "type": "datacenter", "href": cloudBase + "/datacenters/" + d.id},
			"minReplicaCount": 2, "maxReplicaCount": 6,
			"policy": obj{"metric": "INSTANCE_CPU_UTILIZATION_AVERAGE", "range": "PT24H", "unit": "PER_HOUR",
				"scaleInThreshold": 33, "scaleOutThreshold": 77,
				"scaleInAction":  obj{"amount": 1, "amountType": "ABSOLUTE", "cooldownPeriod": "PT5M"},
				"scaleOutAction": obj{"amount": 1, "amountType": "ABSOLUTE", "cooldownPeriod": "PT5M"}},
			"replicaConfiguration": obj{
				"availabilityZone": "AUTO", "cores": 2, "cpuFamily": cpuFamilies[d.spec.Location], "ram": 4096,
				"nics":    []any{obj{"lan": l.id, "name": "nic-" + l.spec.Name, "dhcp": true, "firewallActive": false}},
				"volumes": []any{obj{"name": "root", "size": 50, "type": "SSD", "bootOrder": "AUTO", "image": g.uuid()}},
			},
		},
	})
	for _, sname := range servers {
		sid, ok := g.serverIDs[sname]
		if !ok {
			panic("services: unknown server " + sname)
		}
		gid := g.uuid()
		g.services.children[id] = append(g.services.children[id], obj{
			"id": gid, "type": "autoscaling-server", "href": href + "/servers/" + gid, "metadata": g.svcMeta("state", "AVAILABLE"),
			"properties": obj{"name": sname, "datacenterServer": obj{"id": sid, "type": "server", "href": cloudBase + "/datacenters/" + d.id + "/servers/" + sid}},
		})
	}
}

// certificates: the shop's (its ALB uses it), the CDN's (renewed by ACME), one about to expire and one expired.
func (g *gen) certificates() {
	pem := "-----BEGIN CERTIFICATE-----\n(synthetic, not a real certificate)\n-----END CERTIFICATE-----\n"
	cert := func(id, name, cn string, sans []string, from, until time.Time, auto string) {
		m := g.svcMeta("state", "AVAILABLE")
		m["commonName"], m["subjectAlternativeNames"] = cn, strs(sans)
		m["notBefore"], m["notAfter"] = from.Format(time.RFC3339), until.Format(time.RFC3339)
		m["expired"] = !until.After(g.now)
		m["serialNumber"] = g.hex(16)
		if auto != "" {
			m["autoCertificate"] = auto
		}
		g.services.certs = append(g.services.certs, obj{
			"id": id, "type": "certificate", "href": "https://certificate-manager.de-fra.ionos.com/certificates/" + id, "metadata": m,
			"properties": obj{"name": name, "certificate": pem, "certificateChain": pem},
		})
	}
	day := 24 * time.Hour
	shop := g.albCerts["shop-alb"]
	cert(shop, "shop-example-com", shopZone, []string{shopZone, "www." + shopZone, "beta." + shopZone}, g.now.Add(-200*day), g.now.Add(165*day), "")
	auto := g.uuid()
	cert(g.uuid(), "static-shop-auto", "static."+shopZone, []string{"static." + shopZone}, g.now.Add(-30*day), g.now.Add(60*day), auto)
	cert(g.uuid(), "corp-old-portal", "old-portal."+corpZone, []string{"old-portal." + corpZone}, g.now.Add(-353*day), g.now.Add(12*day), "")
	cert(g.uuid(), "static-2025", "static."+shopZone, []string{"static." + shopZone}, g.now.Add(-460*day), g.now.Add(-95*day), "")
	m := g.svcMeta("state", "AVAILABLE")
	m["lastIssuedCertificate"] = g.services.certs[1].(obj)["id"]
	g.services.autoCerts = append(g.services.autoCerts, obj{
		"id": auto, "type": "autocertificate", "href": "https://certificate-manager.de-fra.ionos.com/auto-certificates/" + auto, "metadata": m,
		"properties": obj{"name": "static-shop-auto", "provider": g.uuid(), "commonName": "static." + shopZone,
			"keyAlgorithm": "rsa2048", "subjectAlternativeNames": []any{"static." + shopZone}},
	})
}

func (g *gen) distribution() {
	id := g.uuid()
	m := g.svcMeta("state", "AVAILABLE")
	m["publicEndpointIpv4"], m["publicEndpointIpv6"] = cdnIPv4, cdnIPv6
	m["ownershipTxtFqdn"] = "_ionos-cdn.static." + shopZone
	m["ownershipTxtValue"] = g.hex(12)
	g.services.cdn = append(g.services.cdn, obj{
		"id": id, "type": "distribution", "href": "https://cdn.de-fra.ionos.com/distributions/" + id, "metadata": m,
		"properties": obj{
			"domain":        "static." + shopZone,
			"certificateId": g.services.certs[1].(obj)["id"],
			"routingRules": []any{
				obj{"scheme": "https", "prefix": "/assets", "upstream": obj{"host": shopZone, "caching": true, "waf": true,
					"rateLimitClass": "R500", "sniMode": "distribution", "geoRestrictions": obj{"blockList": []any{}}}},
				obj{"scheme": "https", "prefix": "/media", "upstream": obj{"host": g.lbIPs["shop-alb"], "caching": true, "waf": false,
					"rateLimitClass": "none", "sniMode": "origin"}},
			},
		},
	})
}

// dns: two zones whose records name the contract's public IPs (and one
// that no longer exists), a secondary zone, and reverse records.
func (g *gen) dns() {
	ip := func(server string) string {
		if v, ok := g.serverIPs[server]; ok {
			return v
		}
		panic("services: no public IP for " + server)
	}
	lb := func(name string) string {
		if v, ok := g.lbIPs[name]; ok {
			return v
		}
		panic("services: no load balancer " + name)
	}
	zone := func(name, description string, records [][4]string) {
		id := g.uuid()
		m := g.svcMeta("state", "AVAILABLE")
		m["nameservers"] = []any{"ns-ic.ui-dns.com", "ns-ic.ui-dns.de", "ns-ic.ui-dns.org", "ns-ic.ui-dns.biz"}
		g.services.zones = append(g.services.zones, obj{
			"id": id, "type": "zone", "href": "https://dns.de-fra.ionos.com/zones/" + id, "metadata": m,
			"properties": obj{"zoneName": name, "description": description, "enabled": true},
		})
		for _, r := range records {
			rid := g.uuid()
			fqdn := name
			if r[0] != "" {
				fqdn = r[0] + "." + name
			}
			rm := g.svcMeta("state", "AVAILABLE")
			rm["fqdn"], rm["zoneId"] = fqdn, id
			prio, _ := strconv.Atoi(r[3])
			g.services.records = append(g.services.records, obj{
				"id": rid, "type": "record", "href": "https://dns.de-fra.ionos.com/zones/" + id + "/records/" + rid, "metadata": rm,
				"properties": obj{"name": r[0], "type": r[1], "content": r[2], "ttl": 3600, "priority": prio, "enabled": true},
			})
		}
	}
	zone(shopZone, "Online shop", [][4]string{
		{"", "A", lb("shop-alb")},
		{"www", "CNAME", shopZone},
		{"beta", "A", lb("shop-alb")},
		{"static", "A", cdnIPv4},
		{"static", "AAAA", cdnIPv6},
		{"", "MX", "mail.example.net", "10"},
		{"", "TXT", "v=spf1 include:example.net -all"},
	})
	zone(corpZone, "Internal services reachable from the internet", [][4]string{
		{"vpn", "A", ip("fra-core-vpn-01")},
		{"vpn-berlin", "A", ip("txl-core-vpn-01")},
		{"bastion", "A", ip("bastion-01")},
		{"api", "A", lb("fra-core-nlb")},
		{"uk", "A", lb("lhr-nlb")},
		{"registry", "CNAME", g.services.registries[0].(obj)["properties"].(obj)["hostname"].(string)},
		// The server behind it is gone: the record points nowhere in the contract.
		{"old-portal", "A", "203.0.113.250"},
	})
	id := g.uuid()
	m := g.svcMeta("state", "AVAILABLE")
	m["nameservers"] = []any{"ns-ic.ui-dns.com", "ns-ic.ui-dns.de"}
	g.services.secondary = append(g.services.secondary, obj{
		"id": id, "type": "secondaryzone", "href": "https://dns.de-fra.ionos.com/secondaryzones/" + id, "metadata": m,
		"properties": obj{"zoneName": "legacy.example.org", "description": "Still served by the old provider", "primaryIps": []any{"192.0.2.53"}},
	})
	for _, r := range [][2]string{{ip("fra-core-vpn-01"), "vpn." + corpZone}, {lb("fra-core-nlb"), "api." + corpZone}} {
		rid := g.uuid()
		m := g.svcMeta("state", "AVAILABLE")
		delete(m, "state")
		g.services.reverse = append(g.services.reverse, obj{
			"id": rid, "type": "reverserecord", "href": "https://dns.de-fra.ionos.com/reverserecords/" + rid, "metadata": m,
			"properties": obj{"name": r[1], "description": "", "ip": r[0]},
		})
	}
}

// emitServices writes the services' collections, every region of each regional API included.
func (g *gen) emitServices() {
	s := g.services
	coll := func(href string, items []any) obj { return vpnCollection(href, items) }
	g.emit(cloudAPI, "/backupunits", "/backupunits", "depth=1", g.entityCollection(cloudBase+"/backupunits", s.backups))
	g.emit(cloudAPI, "/snapshots", "/snapshots", "depth=1", g.entityCollection(cloudBase+"/snapshots", s.snapshots))

	dns := "https://dns.de-fra.ionos.com"
	g.emit(endpoints.DNSAPI, "/zones", "/zones", "", coll(dns+"/zones", s.zones))
	g.emit(endpoints.DNSAPI, "/records", "/records", "", coll(dns+"/records", s.records))
	g.emit(endpoints.DNSAPI, "/secondaryzones", "/secondaryzones", "", coll(dns+"/secondaryzones", s.secondary))
	g.emit(endpoints.DNSAPI, "/reverserecords", "/reverserecords", "", coll(dns+"/reverserecords", s.reverse))

	// MongoDB spells the links without an underscore and has no href.
	g.emit(endpoints.MongoAPI, "/clusters", "/clusters", "", obj{"id": "clusters", "type": "collection",
		"items": nonNil(s.mongo), "offset": 0, "limit": len(s.mongo), "links": obj{}})
	cm := "https://certificate-manager.de-fra.ionos.com"
	g.emit(endpoints.CertAPI, "/certificates", "/certificates", "", coll(cm+"/certificates", s.certs))
	g.emit(endpoints.CertAPI, "/auto-certificates", "/auto-certificates", "", coll(cm+"/auto-certificates", s.autoCerts))
	g.emit(endpoints.CDNAPI, "/distributions", "/distributions", "", coll("https://cdn.de-fra.ionos.com/distributions", s.cdn))

	// The registry list pages by cursor; merged, it is one page like the others.
	cr := "https://api.ionos.com/containerregistries/registries"
	g.emit(endpoints.RegistryAPI, "/registries", "/registries", "", obj{"id": "registries", "type": "collection",
		"items": nonNil(s.registries), "offset": 0, "limit": len(s.registries), "_links": obj{}})
	for _, r := range s.registries {
		id := r.(obj)["id"].(string)
		p := "/registries/" + id + "/repositories"
		g.emit(endpoints.RegistryAPI, "/registries/{registryId}/repositories", p, "", coll(cr+"/"+id+"/repositories", s.children[id]))
	}

	as := "https://api.ionos.com/autoscaling/groups"
	g.emit(endpoints.AutoscalingAPI, "/groups", "/groups", "depth=1", g.entityCollection(as, s.groups))
	for _, gr := range s.groups {
		id := gr.(obj)["id"].(string)
		g.emit(endpoints.AutoscalingAPI, "/groups/{groupId}/servers", "/groups/"+id+"/servers", "depth=1",
			g.entityCollection(as+"/"+id+"/servers", s.children[id]))
	}

	regional := func(regions []string, api func(string) string, host, base string, items map[string][]any, child string) {
		for _, r := range regions {
			root := "https://" + host + "." + r + ".ionos.com" + base
			list := items[r]
			// Kafka's lists have no paging at all.
			if host == "kafka" {
				g.emit(api(r), "/clusters", "/clusters", "", obj{"id": "clusters", "type": "collection", "href": root + "/clusters", "items": nonNil(list)})
			} else {
				top := "/clusters"
				if child == "" && (host == "logging" || host == "monitoring") {
					top = "/pipelines"
				}
				g.emit(api(r), top, top, "", coll(root+top, list))
			}
			if child == "" {
				continue
			}
			for _, c := range list {
				id := c.(obj)["id"].(string)
				p := "/clusters/" + id + "/" + child
				doc := coll(root+p, s.children[id])
				if host == "kafka" {
					doc = obj{"id": child, "type": "collection", "href": root + p, "items": nonNil(s.children[id])}
				}
				g.emit(api(r), "/clusters/{clusterId}/"+child, p, "", doc)
			}
		}
	}
	regional(endpoints.MariaDBRegions, endpoints.MariaDBAPI, "mariadb", "/v2", s.mariadb, "")
	regional(endpoints.InMemoryDBRegions, endpoints.InMemoryDBAPI, "in-memory-db", "/v2", s.inmemorydb, "")
	regional(endpoints.KafkaRegions, endpoints.KafkaAPI, "kafka", "", s.kafka, "topics")
	regional(endpoints.NFSRegions, endpoints.NFSAPI, "nfs", "", s.nfs, "shares")
	regional(endpoints.LoggingRegions, endpoints.LoggingAPI, "logging", "", s.logging, "")
	regional(endpoints.MonitoringRegions, endpoints.MonitoringAPI, "monitoring", "", s.monitoring, "")
}
