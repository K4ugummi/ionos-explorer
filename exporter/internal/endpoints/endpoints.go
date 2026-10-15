// Package endpoints is the complete list of requests ionos-export makes.
// Reviewing this file is reviewing what the exporter can read: it never
// calls anything that is not listed here, and it only ever sends GET.
package endpoints

import (
	"regexp"
	"strings"
)

// API ids double as directory names under raw/ in the snapshot.
const (
	CloudAPI    = "cloudapi-v6"
	PostgresAPI = "postgresql-v1"
)

type API struct {
	ID      string
	Name    string
	Version string
	BaseURL string
}

var APIs = []API{
	{ID: CloudAPI, Name: "Cloud API", Version: "v6", BaseURL: "https://api.ionos.com/cloudapi/v6"},
	{ID: PostgresAPI, Name: "DBaaS PostgreSQL", Version: "v1", BaseURL: "https://api.ionos.com/databases/postgresql"},
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
	{API: CloudAPI, Path: "/datacenters/{datacenterId}/servers", Query: "depth=4", Parent: "/datacenters",
		About: "servers with attached volumes, CD-ROMs, NICs, firewall rules, flow logs"},
	{API: CloudAPI, Path: "/datacenters/{datacenterId}/volumes", Query: "depth=1", Parent: "/datacenters", About: "all volumes, including unattached ones"},
	{API: CloudAPI, Path: "/datacenters/{datacenterId}/lans", Query: "depth=1", Parent: "/datacenters", About: "LANs with their Cross Connect and IP failover"},
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
	{API: PostgresAPI, Path: "/clusters", About: "PostgreSQL clusters and the LANs they connect to"},
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
// /um/users and /um/groups). An API id selects the whole API.
func (e Endpoint) Matches(pattern string) bool {
	if pattern == e.API || pattern == e.Path {
		return true
	}
	p := strings.TrimSuffix(pattern, "/")
	return p != "" && strings.HasPrefix(e.Path, p+"/")
}
