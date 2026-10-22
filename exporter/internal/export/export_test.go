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
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/K4ugummi/ionos-explorer/exporter/internal/endpoints"
	"github.com/K4ugummi/ionos-explorer/exporter/internal/fakeapi"
	"github.com/K4ugummi/ionos-explorer/exporter/internal/httpx"
	"github.com/K4ugummi/ionos-explorer/exporter/internal/snapshot"
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
	for _, a := range endpoints.APIs {
		bases[a.ID] = srv.URL + a.Prefix()
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
	regions := map[string]string{}
	for _, a := range m.APIs {
		regions[a.ID] = a.Region
	}
	if len(m.APIs) != len(endpoints.APIs) || !strings.HasSuffix(m.APIs[0].BaseURL, "/api.ionos.com/cloudapi/v6") ||
		regions[endpoints.PostgresAPI("de-fra")] != "de-fra" || regions[endpoints.DNSAPI] != "" {
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
	// The fixture stands in for real exports; it must cover the same requests
	// (per API family: regions without VPN gateways have no tunnel lists).
	family := func(api string) string { return strings.SplitN(api, "-", 2)[0] }
	type key struct{ api, endpoint, query string }
	plan := map[key]bool{}
	for _, ep := range endpoints.Plan {
		plan[key{family(ep.API), ep.Path, ep.Query}] = true
	}
	seen := map[key]bool{}
	for _, c := range demo(t).Manifest.Coverage {
		k := key{family(c.API), c.Endpoint, c.Query}
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
	apis := demo(t).Manifest.APIs
	if len(apis) != len(endpoints.APIs) {
		t.Errorf("fixture has %d APIs, the exporter %d", len(apis), len(endpoints.APIs))
	}
	for i, a := range endpoints.APIs {
		if i < len(apis) && (apis[i].ID != a.ID || apis[i].BaseURL != a.BaseURL || apis[i].Region != a.Region) {
			t.Errorf("API %s differs from the fixture: %+v", a.ID, apis[i])
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
	cfg.Skip = []string{"/um", "postgresql"}
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
	check("/clusters", "skipped", len(endpoints.PostgresRegions), errExcluded)
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

func TestSecretsNeverReachTheSnapshot(t *testing.T) {
	const secret = "hunter2-do-not-store"
	api := fake(t, demo(t), 100)
	api.Intercept = func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path != "/postgresql.de-fra.ionos.com/clusters" {
			return false
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{map[string]any{
			"id": "c1", "properties": map[string]any{
				"name":        "pg",
				"credentials": map[string]any{"username": "admin", "Password": secret},
				"tunnels":     []any{map[string]any{"preSharedKey": secret, "psk": ""}},
			},
		}}})
		return true
	}
	cfg, _ := start(t, api)
	res, got := export(t, cfg)
	var buf bytes.Buffer
	if err := res.Writer.WriteTo(&buf, snapshot.Options{}); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(buf.Bytes(), []byte(secret)) {
		t.Fatal("a secret ended up in the snapshot")
	}
	var doc struct {
		Items []struct {
			Properties struct {
				Name        string
				Credentials map[string]string
			}
		}
	}
	if err := json.Unmarshal(got.Files["raw/postgresql-v2-de-fra/clusters.json"], &doc); err != nil || len(doc.Items) != 1 {
		t.Fatal(err, doc)
	}
	if c := doc.Items[0].Properties.Credentials; c["username"] != "admin" || c["Password"] != Redacted {
		t.Errorf("credentials %v", c)
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

func TestPlannedAddsUpToProgress(t *testing.T) {
	// ionos-explorer shows "done of total" from these two callbacks.
	api := fake(t, demo(t), 4)
	cfg, _ := start(t, api)
	cfg.Skip = []string{"/um", "vpn"} // placeholders count too
	cfg.Generator = "ionos-explorer"
	var mu sync.Mutex
	var planned, done int
	cfg.Planned = func(n int) {
		mu.Lock()
		planned += n
		mu.Unlock()
	}
	cfg.Progress = func(snapshot.Coverage) {
		mu.Lock()
		done++
		if done > planned {
			t.Errorf("%d done of %d planned", done, planned)
		}
		mu.Unlock()
	}
	res, got := export(t, cfg)
	if planned != done || done != len(res.Manifest.Coverage) {
		t.Errorf("planned %d, done %d, coverage %d", planned, done, len(res.Manifest.Coverage))
	}
	if got.Manifest.Generator.Name != "ionos-explorer" {
		t.Errorf("generator %+v", got.Manifest.Generator)
	}
}

func TestCancel(t *testing.T) {
	api := fake(t, demo(t), 100)
	ctx, cancel := context.WithCancel(context.Background())
	api.Intercept = func(w http.ResponseWriter, r *http.Request) bool {
		if strings.HasSuffix(r.URL.Path, "/servers") {
			cancel()
		}
		return false
	}
	cfg, _ := start(t, api)
	if _, err := Run(ctx, cfg); !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v", err)
	}
}

// Lists that page by cursor (pagination.token, the Container Registry and
// DNS) are followed by cursor, without an offset; MongoDB's links count as
// _links. Merged, every list is one page without links or cursor.
func TestCursorsAndLinks(t *testing.T) {
	api := fake(t, demo(t), 100)
	var queries []string
	var mu sync.Mutex
	page := func(items []any, extra map[string]any) map[string]any {
		doc := map[string]any{"id": "registries", "type": "collection", "items": items}
		for k, v := range extra {
			doc[k] = v
		}
		return doc
	}
	api.Intercept = func(w http.ResponseWriter, r *http.Request) bool {
		q := r.URL.Query()
		switch r.URL.Path {
		case "/api.ionos.com/containerregistries/registries":
			mu.Lock()
			queries = append(queries, r.URL.RawQuery)
			mu.Unlock()
			if q.Has("offset") {
				t.Errorf("offset with a cursor: %s", r.URL)
			}
			var doc map[string]any
			switch q.Get("pagination.token") {
			case "":
				doc = page([]any{map[string]any{"id": "r1"}}, map[string]any{"pagination": map[string]any{"limit": 1, "token": "c1"}, "_links": map[string]any{"next": "https://evil.example/"}})
			case "c1":
				doc = page([]any{map[string]any{"id": "r2"}}, map[string]any{"pagination": map[string]any{"limit": 1, "token": "c2"}})
			default:
				doc = page([]any{map[string]any{"id": "r3"}}, map[string]any{"pagination": map[string]any{"limit": 1}})
			}
			_ = json.NewEncoder(w).Encode(doc)
			return true
		case "/api.ionos.com/databases/mongodb/clusters":
			if q.Get("offset") == "" {
				_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{map[string]any{"id": "m1"}}, "offset": 0, "limit": 1,
					"links": map[string]any{"next": "https://evil.example/"}})
			} else {
				_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{map[string]any{"id": "m2"}}, "offset": 1, "limit": 1, "links": map[string]any{}})
			}
			return true
		case "/api.ionos.com/containerregistries/registries/r1/repositories",
			"/api.ionos.com/containerregistries/registries/r2/repositories",
			"/api.ionos.com/containerregistries/registries/r3/repositories":
			_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{}})
			return true
		}
		return false
	}
	cfg, _ := start(t, api)
	_, got := export(t, cfg)
	if len(queries) != 3 || queries[1] != "pagination.token=c1" || queries[2] != "pagination.token=c2" {
		t.Errorf("registry requests %q", queries)
	}
	for file, want := range map[string]int{"raw/containerregistry-v1/registries.json": 3, "raw/mongodb-v1/clusters.json": 2} {
		var doc map[string]any
		if err := json.Unmarshal(got.Files[file], &doc); err != nil {
			t.Fatal(file, err)
		}
		if n := len(doc["items"].([]any)); n != want {
			t.Errorf("%s: %d items, want %d", file, n, want)
		}
		if _, ok := doc["pagination"]; ok {
			t.Errorf("%s keeps the cursor", file)
		}
		if l, ok := doc["links"]; ok && len(l.(map[string]any)) != 0 {
			t.Errorf("%s keeps links %v", file, l)
		}
	}
}

func TestRepeatedCursorStops(t *testing.T) {
	api := fake(t, demo(t), 100)
	var n atomic.Int64
	api.Intercept = func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path != "/api.ionos.com/containerregistries/registries" {
			return false
		}
		n.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{map[string]any{"id": "r1"}}, "pagination": map[string]any{"token": "same"}})
		return true
	}
	cfg, _ := start(t, api)
	cfg.Plan = []endpoints.Endpoint{{API: endpoints.RegistryAPI, Path: "/registries"}}
	res, _ := export(t, cfg)
	if c := res.Manifest.Coverage[0]; c.Status != snapshot.StatusError || !strings.Contains(c.Error, "cursor") || n.Load() != 2 {
		t.Errorf("%+v after %d requests", c, n.Load())
	}
}

// A field secret in one API only (the key of a logging pipeline) is removed
// there; elsewhere a "key" is data (a label's key).
func TestEndpointSecrets(t *testing.T) {
	const secret = "pipeline-key-do-not-store"
	api := fake(t, demo(t), 100)
	api.Intercept = func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path != "/logging.de-txl.ionos.com/pipelines" {
			return false
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{map[string]any{
			"id": "p1", "properties": map[string]any{"name": "logs", "key": secret,
				"replicaConfiguration": map[string]any{"userData": secret, "secretKey": secret}},
		}}})
		return true
	}
	cfg, _ := start(t, api)
	_, got := export(t, cfg)
	for _, b := range got.Files {
		if bytes.Contains(b, []byte(secret)) {
			t.Fatal("a secret ended up in the snapshot")
		}
	}
	if !bytes.Contains(got.Files["raw/cloudapi-v6/labels.json"], []byte(`"env"`)) || bytes.Contains(got.Files["raw/cloudapi-v6/labels.json"], []byte(Redacted)) {
		t.Error("label keys must stay")
	}
}
