// Package endpoints is the complete list of requests ionos-export makes.
// Reviewing this file is reviewing what the exporter can read: it never
// calls anything that is not listed here, and it only ever sends GET.
package endpoints

import (
	"net/url"
	"regexp"
	"slices"
	"strings"
)

// API ids double as directory names under raw/ in the snapshot.
const CloudAPI = "cloudapi-v6"

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
)

// PostgresAPI is the API id of the DBaaS PostgreSQL v2 API in a region. The
// global v1 API was shut down in September 2026.
func PostgresAPI(region string) string { return "postgresql-v2-" + region }

// VPNAPI is the API id of the VPN Gateway API in a region.
func VPNAPI(region string) string { return "vpn-v1-" + region }

var APIs = slices.Concat(
	[]API{{ID: CloudAPI, Name: "Cloud API", Version: "v6", BaseURL: "https://api.ionos.com/cloudapi/v6"}},
	regional(PostgresRegions, PostgresAPI, "DBaaS PostgreSQL", "v2", "postgresql"),
	regional(VPNRegions, VPNAPI, "VPN Gateway", "v1", "vpn"),
)

func regional(regions []string, id func(string) string, name, version, host string) []API {
	var out []API
	for _, r := range regions {
		out = append(out, API{ID: id(r), Name: name, Version: version, BaseURL: "https://" + host + "." + r + ".ionos.com", Region: r})
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
