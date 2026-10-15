package export

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ionos-explorer/exporter/internal/endpoints"
	"ionos-explorer/exporter/internal/fakeapi"
	"ionos-explorer/exporter/internal/httpx"
	"ionos-explorer/exporter/internal/snapshot"
)

// The demo contract, as the explorer expects it.
func demo(t *testing.T) *snapshot.Snapshot {
	t.Helper()
	s, err := fakeapi.Demo()
	if err != nil {
		t.Fatal(err)
	}
	return s
}

const token = "test-token-0123456789"

func fake(t *testing.T, snap *snapshot.Snapshot, pageSize int) *fakeapi.Server {
	return &fakeapi.Server{Snap: snap, Token: token, PageSize: pageSize, Errorf: t.Errorf}
}

func start(t *testing.T, api *fakeapi.Server) (Config, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(api)
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	client := httpx.New(httpx.Options{
		Credentials: httpx.Credentials{Token: token},
		Hosts:       []string{u.Host},
		Backoff:     time.Millisecond,
	})
	bases := map[string]string{}
	for id, p := range fakeapi.Prefixes {
		bases[id] = srv.URL + p
	}
	return Config{
		Client: client, BaseURLs: bases, Version: "test",
		Now: func() time.Time { return time.Date(2026, 10, 15, 8, 0, 0, 123, time.UTC) },
	}, srv
}

func export(t *testing.T, cfg Config) (*Result, *snapshot.Snapshot) {
	t.Helper()
	res, err := Run(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := res.Writer.WriteTo(&buf, snapshot.Options{}); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(buf.Bytes(), []byte(token)) {
		t.Fatal("the token ended up in the snapshot")
	}
	out, err := snapshot.Read(&buf)
	if err != nil {
		t.Fatal(err)
	}
	return res, out
}

func TestExportReproducesTheAPI(t *testing.T) {
	want := demo(t)
	api := fake(t, want, 3)
	cfg, _ := start(t, api)
	res, got := export(t, cfg)

	if len(got.Files) != len(want.Files) {
		t.Errorf("got %d files, want %d", len(got.Files), len(want.Files))
	}
	for path, b := range want.Files {
		if !bytes.Equal(got.Files[path], b) {
			t.Errorf("%s differs from what the API served", path)
		}
	}
	type key struct{ api, endpoint, path, query, status, file string }
	cov := map[key]bool{}
	for _, c := range want.Manifest.Coverage {
		cov[key{c.API, c.Endpoint, c.Path, c.Query, c.Status, c.File}] = true
	}
	for _, c := range got.Manifest.Coverage {
		k := key{c.API, c.Endpoint, c.Path, c.Query, c.Status, c.File}
		if !cov[k] {
			t.Errorf("unexpected coverage %+v", c)
		}
		delete(cov, k)
	}
	for k := range cov {
		t.Errorf("missing coverage %+v", k)
	}

	m := got.Manifest
	if m.Generator.Name != "ionos-export" || m.Synthetic || m.Contract == nil || m.Contract.Number != 31812345 {
		t.Errorf("manifest: %+v %+v", m.Generator, m.Contract)
	}
	if !m.CreatedAt.Equal(time.Date(2026, 10, 15, 8, 0, 0, 0, time.UTC)) {
		t.Errorf("createdAt %v", m.CreatedAt)
	}
	if len(m.APIs) != 2 || !strings.HasSuffix(m.APIs[0].BaseURL, "/cloudapi/v6") {
		t.Errorf("apis %+v", m.APIs)
	}
	// /um/users and /um/groups are forbidden in the demo contract.
	if !res.Partial() {
		t.Error("an export with forbidden endpoints must be partial")
	}
	var servers snapshot.Coverage
	for _, c := range m.Coverage {
		if strings.HasSuffix(c.Path, "/servers") && *c.Items > 6 {
			servers = c
		}
	}
	if servers.Pages < 3 {
		t.Errorf("expected a paginated server list, got %+v", servers)
	}
}

func TestExportIsDeterministic(t *testing.T) {
	api := fake(t, demo(t), 4)
	cfg, _ := start(t, api)
	cfg.Parallel = 8
	var archives [2][]byte
	for i := range archives {
		res, err := Run(context.Background(), cfg)
		if err != nil {
			t.Fatal(err)
		}
		var buf bytes.Buffer
		if err := res.Writer.WriteTo(&buf, snapshot.Options{}); err != nil {
			t.Fatal(err)
		}
		archives[i] = buf.Bytes()
	}
	if !bytes.Equal(archives[0], archives[1]) {
		t.Error("two exports of the same API state differ")
	}
}

func TestPlanMatchesTheFixture(t *testing.T) {
	// The fixture stands in for real exports; it must cover the same requests.
	type key struct{ api, endpoint, query string }
	plan := map[key]bool{}
	for _, ep := range endpoints.Plan {
		plan[key{ep.API, ep.Path, ep.Query}] = true
	}
	seen := map[key]bool{}
	for _, c := range demo(t).Manifest.Coverage {
		k := key{c.API, c.Endpoint, c.Query}
		if !plan[k] {
			t.Errorf("fixture has %+v, which the exporter does not fetch", k)
		}
		seen[k] = true
	}
	for k := range plan {
		if !seen[k] {
			t.Errorf("the exporter fetches %+v, which the fixture lacks", k)
		}
	}
	for _, a := range endpoints.APIs {
		found := false
		for _, b := range demo(t).Manifest.APIs {
			found = found || (a.ID == b.ID && a.BaseURL == b.BaseURL)
		}
		if !found {
			t.Errorf("API %s differs from the fixture", a.ID)
		}
	}
}

func TestBadCredentialsFailFast(t *testing.T) {
	api := fake(t, demo(t), 100)
	cfg, srv := start(t, api)
	u, _ := url.Parse(srv.URL)
	cfg.Client = httpx.New(httpx.Options{Credentials: httpx.Credentials{Token: "wrong"}, Hosts: []string{u.Host}})
	if _, err := Run(context.Background(), cfg); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("got %v", err)
	}
	if n := api.Requests.Load(); n != 1 {
		t.Errorf("%d requests with rejected credentials", n)
	}
}

func TestFailuresAreRecordedNotFatal(t *testing.T) {
	snap := demo(t)
	api := fake(t, snap, 100)
	var dcs atomic.Int64
	api.Intercept = func(w http.ResponseWriter, r *http.Request) bool {
		switch {
		case strings.HasSuffix(r.URL.Path, "/k8s"):
			fakeapi.WriteError(w, 403, "VDC-14-1", "no k8s for you")
		case strings.HasSuffix(r.URL.Path, "/natgateways"):
			fakeapi.WriteError(w, 500, "VDC-1-1", "boom")
		case strings.HasSuffix(r.URL.Path, "/lans") && dcs.Add(1) == 1:
			fakeapi.WriteError(w, 429, "RATE", "slow down") // retried
		case strings.HasSuffix(r.URL.Path, "/images"):
			_, _ = w.Write([]byte("<html>not json</html>"))
		default:
			return false
		}
		return true
	}
	cfg, _ := start(t, api)
	cfg.Skip = []string{"/um", endpoints.PostgresAPI}
	res, got := export(t, cfg)

	status := map[string]map[string]int{}
	errs := map[string]string{}
	for _, c := range got.Manifest.Coverage {
		if status[c.Endpoint] == nil {
			status[c.Endpoint] = map[string]int{}
		}
		status[c.Endpoint][c.Status]++
		errs[c.Endpoint] = c.Error
	}
	check := func(endpoint, st string, n int, errPart string) {
		t.Helper()
		if status[endpoint][st] != n || !strings.Contains(errs[endpoint], errPart) {
			t.Errorf("%s: %v %q, want %d × %s %q", endpoint, status[endpoint], errs[endpoint], n, st, errPart)
		}
	}
	check("/k8s", "forbidden", 1, "[VDC-14-1] no k8s for you")
	check("/k8s/{k8sClusterId}/nodepools", "skipped", 1, "needs /k8s: /k8s was forbidden")
	check("/datacenters/{datacenterId}/natgateways", "error", 14, "[VDC-1-1] boom")
	check("/datacenters/{datacenterId}/lans", "ok", 14, "")
	check("/images", "error", 1, "not a JSON object")
	check("/um/users", "skipped", 1, errExcluded)
	check("/clusters", "skipped", 1, errExcluded)
	if !res.Partial() {
		t.Error("should be partial")
	}

	// Without the injected failures, only exclusions remain: complete.
	api.Intercept = nil
	res, _ = export(t, cfg)
	if res.Partial() {
		t.Error("excluded endpoints alone must not make an export partial")
	}
}

func TestRefusesUnusableIDs(t *testing.T) {
	api := fake(t, demo(t), 100)
	api.Intercept = func(w http.ResponseWriter, r *http.Request) bool {
		if strings.Contains(r.URL.Path, "..") || strings.Contains(r.URL.Path, "datacenters/nodepools") {
			t.Errorf("requested %s", r.URL.Path)
		}
		if !strings.HasSuffix(r.URL.Path, "/k8s") {
			return false
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{map[string]any{"id": "../../datacenters"}}})
		return true
	}
	cfg, _ := start(t, api)
	_, got := export(t, cfg)
	for _, c := range got.Manifest.Coverage {
		if c.Endpoint == "/k8s/{k8sClusterId}/nodepools" && (c.Status != "error" || !strings.Contains(c.Error, "unusable id")) {
			t.Errorf("%+v", c)
		}
	}
	for p := range got.Files {
		if strings.Contains(p, "..") {
			t.Errorf("file %s", p)
		}
	}
}

func TestCheckPlan(t *testing.T) {
	bad := [][]endpoints.Endpoint{
		{},
		{{API: endpoints.CloudAPI, Path: "/x/{id}/y", Parent: "/x"}},
		{{API: endpoints.CloudAPI, Path: "/x"}, {API: endpoints.CloudAPI, Path: "/x/{id}/y", Parent: "/z"}},
		{{API: endpoints.CloudAPI, Path: "/x/{id}"}},
		{{API: "nope", Path: "/x"}},
	}
	for i, p := range bad {
		if checkPlan(p) == nil {
			t.Errorf("plan %d accepted", i)
		}
	}
	if err := checkPlan(endpoints.Plan); err != nil {
		t.Error(err)
	}
	if endpoints.Plan[0].Path != "/contracts" {
		t.Error("the first request should be the cheap /contracts")
	}
}
