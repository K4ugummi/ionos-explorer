// Package endpoints is the complete list of requests ionos-export makes.
// Reviewing this file is reviewing what the exporter can read: it never
// calls anything that is not listed here, and it only ever sends GET.
package endpoints

import (
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"
)

// API ids double as directory names under raw/ in the snapshot. Each is
// "<family>-v<major>", and "-<region>" for a regional API.
const (
	CloudAPI       = "cloudapi-v6"
	DNSAPI         = "dns-v1"
	MongoAPI       = "mongodb-v1"
	CertAPI        = "certmanager-v2"
	CDNAPI         = "cdn-v1"
	RegistryAPI    = "containerregistry-v1"
	AutoscalingAPI = "autoscaling-v1"
)

type API struct {
	ID      string
	Name    string
	Version string
	BaseURL string
	Region  string // for regional APIs
}

// Regional APIs have one host per location, and each region is its own API
// in the snapshot.
var (
	// https://docs.ionos.com/cloud/databases/postgresql/api/v2-api
	PostgresRegions = []string{"de-fra", "de-txl", "es-vit", "fr-par", "gb-bhx", "gb-lhr", "us-ewr", "us-las", "us-mci"}
	// https://api.ionos.com/docs/vpn/v1
	VPNRegions = []string{"de-fra", "de-txl", "es-vit", "fr-par", "gb-lhr", "us-ewr", "us-las", "us-mci"}
	// The servers lists of the APIs' OpenAPI documents
	// (https://api.ionos.com/docs/public-<name>.ga.yml).
	MariaDBRegions    = PostgresRegions
	InMemoryDBRegions = PostgresRegions
	KafkaRegions      = PostgresRegions
	NFSRegions        = VPNRegions
	LoggingRegions    = PostgresRegions
	MonitoringRegions = PostgresRegions
)

// PostgresAPI is the API id of the DBaaS PostgreSQL v2 API in a region. The
// global v1 API was shut down in September 2026.
func PostgresAPI(region string) string { return "postgresql-v2-" + region }

// VPNAPI is the API id of the VPN Gateway API in a region.
func VPNAPI(region string) string { return "vpn-v1-" + region }

// MariaDBAPI is the API id of the DBaaS MariaDB v2 API in a region (v1 was shut down).
func MariaDBAPI(region string) string { return "mariadb-v2-" + region }

// InMemoryDBAPI is the API id of the DBaaS In-Memory DB v2 API in a region (v1 was shut down).
func InMemoryDBAPI(region string) string { return "inmemorydb-v2-" + region }

// KafkaAPI is the API id of the Event Streams for Apache Kafka API in a region.
func KafkaAPI(region string) string { return "kafka-v1-" + region }

// NFSAPI is the API id of the Network File Storage API in a region.
func NFSAPI(region string) string { return "nfs-v1-" + region }

// LoggingAPI is the API id of the Logging Service API in a region.
func LoggingAPI(region string) string { return "logging-v1-" + region }

// MonitoringAPI is the API id of the Monitoring Service API in a region.
func MonitoringAPI(region string) string { return "monitoring-v1-" + region }

var APIs = slices.Concat(
	[]API{
		{ID: CloudAPI, Name: "Cloud API", Version: "v6", BaseURL: "https://api.ionos.com/cloudapi/v6"},
		{ID: DNSAPI, Name: "Cloud DNS", Version: "v1", BaseURL: "https://dns.de-fra.ionos.com"},
		{ID: MongoAPI, Name: "DBaaS MongoDB", Version: "v1", BaseURL: "https://api.ionos.com/databases/mongodb"},
		{ID: CertAPI, Name: "Certificate Manager", Version: "v2", BaseURL: "https://certificate-manager.de-fra.ionos.com"},
		{ID: CDNAPI, Name: "CDN", Version: "v1", BaseURL: "https://cdn.de-fra.ionos.com"},
		{ID: RegistryAPI, Name: "Container Registry", Version: "v1", BaseURL: "https://api.ionos.com/containerregistries"},
		{ID: AutoscalingAPI, Name: "VM Auto Scaling", Version: "v1", BaseURL: "https://api.ionos.com/autoscaling"},
	},
	regional(PostgresRegions, PostgresAPI, "DBaaS PostgreSQL", "v2", "postgresql", ""),
	regional(VPNRegions, VPNAPI, "VPN Gateway", "v1", "vpn", ""),
	regional(MariaDBRegions, MariaDBAPI, "DBaaS MariaDB", "v2", "mariadb", "/v2"),
	regional(InMemoryDBRegions, InMemoryDBAPI, "DBaaS In-Memory DB", "v2", "in-memory-db", "/v2"),
	regional(KafkaRegions, KafkaAPI, "Event Streams for Apache Kafka", "v1", "kafka", ""),
	regional(NFSRegions, NFSAPI, "Network File Storage", "v1", "nfs", ""),
	regional(LoggingRegions, LoggingAPI, "Logging Service", "v1", "logging", ""),
	regional(MonitoringRegions, MonitoringAPI, "Monitoring Service", "v1", "monitoring", ""),
)

func regional(regions []string, id func(string) string, name, version, host, path string) []API {
	var out []API
	for _, r := range regions {
		out = append(out, API{ID: id(r), Name: name, Version: version, BaseURL: "https://" + host + "." + r + ".ionos.com" + path, Region: r})
	}
	return out
}

// Endpoint is one collection the exporter lists.
type Endpoint struct {
	API   string
	Path  string // path template below the API base URL
	Query string
	// Parent is the Path of a collection in the same API whose item ids fill
	// the single {param} in Path, e.g. /datacenters for
	// /datacenters/{datacenterId}/servers. Parents are top-level endpoints.
	Parent string
	// What the explorer gets from it; printed by `ionos-export --list`.
	About string
	// Fields that hold a secret in this endpoint's answers, besides the ones
	// removed everywhere (export.secretKeys); lower case. For names too
	// common to remove everywhere, such as "key" (a label's key is none).
	Secrets []string
}

var Plan = []Endpoint{
	{API: CloudAPI, Path: "/contracts", About: "contract number, owner, resource limits"},
	{API: CloudAPI, Path: "/datacenters", Query: "depth=1", About: "datacenters"},
	// depth=4 returns firewall rules as bare references; their contents need 5.
	{API: CloudAPI, Path: "/datacenters/{datacenterId}/servers", Query: "depth=5", Parent: "/datacenters",
		About: "servers with attached volumes, CD-ROMs, NICs, firewall rules, flow logs, Security Groups"},
	{API: CloudAPI, Path: "/datacenters/{datacenterId}/volumes", Query: "depth=1", Parent: "/datacenters", About: "all volumes, including unattached ones"},
	{API: CloudAPI, Path: "/datacenters/{datacenterId}/lans", Query: "depth=1", Parent: "/datacenters", About: "LANs with their Cross Connect and IP failover"},
	{API: CloudAPI, Path: "/datacenters/{datacenterId}/securitygroups", Query: "depth=3", Parent: "/datacenters",
		About: "network Security Groups with their rules and members"},
	{API: CloudAPI, Path: "/datacenters/{datacenterId}/natgateways", Query: "depth=3", Parent: "/datacenters", About: "NAT gateways with rules and flow logs"},
	{API: CloudAPI, Path: "/datacenters/{datacenterId}/networkloadbalancers", Query: "depth=3", Parent: "/datacenters",
		About: "network load balancers with forwarding rules"},
	{API: CloudAPI, Path: "/datacenters/{datacenterId}/applicationloadbalancers", Query: "depth=3", Parent: "/datacenters",
		About: "application load balancers with forwarding rules"},
	{API: CloudAPI, Path: "/pccs", Query: "depth=1", About: "Cross Connects and their peer LANs"},
	{API: CloudAPI, Path: "/ipblocks", Query: "depth=1", About: "reserved IP blocks and what uses each IP"},
	{API: CloudAPI, Path: "/targetgroups", Query: "depth=1", About: "application load balancer target groups"},
	{API: CloudAPI, Path: "/templates", Query: "depth=1", About: "Cube templates"},
	{API: CloudAPI, Path: "/images", Query: "depth=1", About: "public and private images (names volumes' images)"},
	{API: CloudAPI, Path: "/k8s", Query: "depth=1", About: "managed Kubernetes clusters"},
	{API: CloudAPI, Path: "/k8s/{k8sClusterId}/nodepools", Query: "depth=1", Parent: "/k8s", About: "Kubernetes node pools and their LANs"},
	{API: CloudAPI, Path: "/labels", Query: "depth=1", About: "labels of all resources"},
	{API: CloudAPI, Path: "/um/users", Query: "depth=1", About: "users (usually forbidden for non-admin users)"},
	{API: CloudAPI, Path: "/um/groups", Query: "depth=1", About: "groups (usually forbidden for non-admin users)"},
	{API: CloudAPI, Path: "/backupunits", Query: "depth=1", About: "backup units (their password is never stored)"},
	{API: CloudAPI, Path: "/snapshots", Query: "depth=1", About: "volume snapshots"},

	{API: DNSAPI, Path: "/zones", About: "DNS zones"},
	{API: DNSAPI, Path: "/records", About: "DNS records of all zones, linked to the resources whose IPs they name"},
	{API: DNSAPI, Path: "/secondaryzones", About: "secondary DNS zones and their primary name servers"},
	{API: DNSAPI, Path: "/reverserecords", About: "reverse DNS records of the contract's IPs"},
	{API: MongoAPI, Path: "/clusters", About: "MongoDB clusters and the LANs they connect to"},
	{API: CertAPI, Path: "/certificates", About: "certificates: names and validity (private keys are never returned)"},
	{API: CertAPI, Path: "/auto-certificates", About: "certificates renewed automatically (ACME)"},
	{API: CDNAPI, Path: "/distributions", About: "CDN distributions: domain, certificate, origins"},
	{API: RegistryAPI, Path: "/registries", About: "container registries"},
	{API: RegistryAPI, Path: "/registries/{registryId}/repositories", Parent: "/registries", About: "repositories in each registry"},
	{API: AutoscalingAPI, Path: "/groups", Query: "depth=1", About: "VM Auto Scaling groups and the LANs of their servers"},
	{API: AutoscalingAPI, Path: "/groups/{groupId}/servers", Query: "depth=1", Parent: "/groups", About: "the servers each group created"},
}

func init() {
	for _, r := range PostgresRegions {
		Plan = append(Plan, Endpoint{API: PostgresAPI(r), Path: "/clusters", About: "PostgreSQL clusters and the LAN each connects to"})
	}
	for _, r := range VPNRegions {
		Plan = append(Plan,
			Endpoint{API: VPNAPI(r), Path: "/ipsecgateways", About: "IPsec VPN gateways and the LANs they connect to"},
			Endpoint{API: VPNAPI(r), Path: "/ipsecgateways/{gatewayId}/tunnels", Parent: "/ipsecgateways",
				About: "IPsec tunnels: remote host and networks (pre-shared keys are never returned)"},
			Endpoint{API: VPNAPI(r), Path: "/wireguardgateways", About: "WireGuard VPN gateways"},
			Endpoint{API: VPNAPI(r), Path: "/wireguardgateways/{gatewayId}/peers", Parent: "/wireguardgateways",
				About: "WireGuard peers: endpoint and allowed IPs"},
		)
	}
	for _, r := range MariaDBRegions {
		Plan = append(Plan, Endpoint{API: MariaDBAPI(r), Path: "/clusters", About: "MariaDB clusters and the LAN each connects to"})
	}
	for _, r := range InMemoryDBRegions {
		Plan = append(Plan, Endpoint{API: InMemoryDBAPI(r), Path: "/clusters", About: "In-Memory DB (Redis) clusters and the LAN each connects to"})
	}
	for _, r := range KafkaRegions {
		Plan = append(Plan,
			Endpoint{API: KafkaAPI(r), Path: "/clusters", About: "Kafka clusters, their brokers and LANs"},
			// Never /users/{id}/access: it hands out client certificates with private keys.
			Endpoint{API: KafkaAPI(r), Path: "/clusters/{clusterId}/topics", Parent: "/clusters", About: "Kafka topics"},
		)
	}
	for _, r := range NFSRegions {
		Plan = append(Plan,
			Endpoint{API: NFSAPI(r), Path: "/clusters", About: "Network File Storage clusters and the LAN each connects to"},
			Endpoint{API: NFSAPI(r), Path: "/clusters/{clusterId}/shares", Parent: "/clusters", About: "NFS shares and who may mount them"},
		)
	}
	for _, r := range LoggingRegions {
		Plan = append(Plan, Endpoint{API: LoggingAPI(r), Path: "/pipelines", About: "logging pipelines (their keys are never stored)", Secrets: []string{"key"}})
	}
	for _, r := range MonitoringRegions {
		Plan = append(Plan, Endpoint{API: MonitoringAPI(r), Path: "/pipelines", About: "monitoring pipelines (their keys are never stored)", Secrets: []string{"key"}})
	}
}

// FindAPI returns the API with the given id.
func FindAPI(id string) (API, bool) {
	for _, a := range APIs {
		if a.ID == id {
			return a, true
		}
	}
	return API{}, false
}

// Bases returns the base URL per API and the hosts a client may reach. With
// an override (--base-url, for a local mock), every API lives below it at
// its Prefix.
func Bases(override string) (map[string]string, []string, error) {
	bases := map[string]string{}
	seen := map[string]bool{}
	var hosts []string
	for _, a := range APIs {
		base := a.BaseURL
		if override != "" {
			u, err := url.Parse(strings.TrimSuffix(override, "/"))
			if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
				return nil, nil, fmt.Errorf("--base-url %q: want an absolute http(s) URL", override)
			}
			base = u.String() + a.Prefix()
		}
		bases[a.ID] = base
		u, _ := url.Parse(base)
		if !seen[u.Host] {
			seen[u.Host] = true
			hosts = append(hosts, u.Host)
		}
	}
	return bases, hosts, nil
}

var param = regexp.MustCompile(`\{[A-Za-z0-9]+\}`)

// Prefix is where an API lives below a --base-url: its host and path, so
// APIs on different hosts stay apart ("/api.ionos.com/cloudapi/v6").
func (a API) Prefix() string {
	u, err := url.Parse(a.BaseURL)
	if err != nil {
		return "/" + a.ID
	}
	return "/" + u.Host + u.Path
}

// Expand fills the {param} in a child endpoint's path with id.
func (e Endpoint) Expand(id string) string {
	return param.ReplaceAllLiteralString(e.Path, id)
}

// Params counts the {param} segments in the path.
func (e Endpoint) Params() int {
	return len(param.FindAllString(e.Path, -1))
}

// Matches reports whether the endpoint is selected by a --skip pattern: its
// exact path template, or a prefix ending at a path segment ("/um" skips
// /um/users and /um/groups). An API id selects the whole API, its family
// ("vpn") all regions of it.
func (e Endpoint) Matches(pattern string) bool {
	if pattern == e.API || pattern == e.Path || (pattern != "" && strings.HasPrefix(e.API, pattern+"-")) {
		return true
	}
	p := strings.TrimSuffix(pattern, "/")
	return p != "" && strings.HasPrefix(e.Path, p+"/")
}
