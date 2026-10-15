package endpoints

import "testing"

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
}
