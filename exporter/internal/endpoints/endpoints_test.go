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
		{users, "postgresql-v1", false},
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
}
