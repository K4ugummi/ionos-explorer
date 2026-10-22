package endpoints

import (
	"strings"
	"testing"
)

func TestMatches(t *testing.T) {
	users := Endpoint{API: CloudAPI, Path: "/um/users"}
	servers := Endpoint{API: CloudAPI, Path: "/datacenters/{datacenterId}/servers"}
	for _, c := range []struct {
		ep      Endpoint
		pattern string
		want    bool
	}{
		{users, "/um/users", true},
		{users, "/um", true},
		{users, "/um/", true},
		{users, "/u", false},
		{users, "cloudapi-v6", true},
		{users, "postgresql", false},
		{Endpoint{API: PostgresAPI("gb-bhx"), Path: "/clusters"}, "postgresql", true},
		{users, "cloudapi", true},
		{users, "cloud", false},
		{Endpoint{API: VPNAPI("de-fra"), Path: "/ipsecgateways"}, "vpn", true},
		{Endpoint{API: VPNAPI("de-fra"), Path: "/ipsecgateways"}, "vpn-v1-de-txl", false},
		{servers, "/datacenters", true},
		{servers, "/datacenters/{datacenterId}/servers", true},
		{servers, "/datacenters/{datacenterId}/volumes", false},
		{servers, "/", false},
		{servers, "", false},
		{Endpoint{API: MariaDBAPI("de-fra"), Path: "/clusters"}, "mariadb", true},
		{Endpoint{API: InMemoryDBAPI("de-fra"), Path: "/clusters"}, "mariadb", false},
		{Endpoint{API: DNSAPI, Path: "/records"}, "dns", true},
	} {
		if got := c.ep.Matches(c.pattern); got != c.want {
			t.Errorf("%s matches %q = %v", c.ep.Path, c.pattern, got)
		}
	}
	if got := servers.Expand("abc"); got != "/datacenters/abc/servers" {
		t.Error(got)
	}
	if got := APIs[0].Prefix(); got != "/api.ionos.com/cloudapi/v6" {
		t.Error(got)
	}
	if a, _ := FindAPI(VPNAPI("gb-lhr")); a.Prefix() != "/vpn.gb-lhr.ionos.com" || a.Region != "gb-lhr" {
		t.Error(a)
	}
	if a, _ := FindAPI(MariaDBAPI("de-txl")); a.Prefix() != "/mariadb.de-txl.ionos.com/v2" {
		t.Error(a)
	}
}

// The catalogue is consistent: unique API ids of the form <family>-v<n>[-<region>],
// every endpoint on a known API, children below a top-level endpoint of
// theirs, and only paths a reviewer would expect.
func TestCatalogue(t *testing.T) {
	ids := map[string]bool{}
	for _, a := range APIs {
		if ids[a.ID] {
			t.Errorf("API %s twice", a.ID)
		}
		ids[a.ID] = true
		want := "-" + a.Version
		if a.Region != "" {
			want += "-" + a.Region
		}
		if !strings.HasSuffix(a.ID, want) || !strings.HasPrefix(a.BaseURL, "https://") {
			t.Errorf("API %s: version %s, region %q, base %s", a.ID, a.Version, a.Region, a.BaseURL)
		}
	}
	tops := map[string]bool{}
	for _, e := range Plan {
		if !ids[e.API] {
			t.Errorf("%s %s: unknown API", e.API, e.Path)
		}
		if e.Parent == "" {
			tops[e.API+" "+e.Path] = true
		}
		if e.About == "" {
			t.Errorf("%s %s: no About", e.API, e.Path)
		}
		// Endpoints that hand out credentials are never listed.
		for _, bad := range []string{"/access", "/tokens", "/kubeconfig", "/ssourl", "/users/"} {
			if strings.Contains(e.Path, bad) {
				t.Errorf("%s %s: must not be called", e.API, e.Path)
			}
		}
	}
	for _, e := range Plan {
		if e.Parent != "" && (!tops[e.API+" "+e.Parent] || e.Params() != 1) {
			t.Errorf("%s %s: parent %s", e.API, e.Path, e.Parent)
		}
	}
	if _, ok := FindAPI(NFSAPI("gb-bhx")); ok {
		t.Error("NFS has no gb-bhx host")
	}
}
