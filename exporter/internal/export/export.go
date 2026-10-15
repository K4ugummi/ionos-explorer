// Package export fetches every collection in the endpoint plan and turns the
// responses into a snapshot. It stores what the API returns, merging pages
// but not interpreting anything; the explorer does that.
package export

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"sync"
	"time"

	"ionos-explorer/exporter/internal/endpoints"
	"ionos-explorer/exporter/internal/httpx"
	"ionos-explorer/exporter/internal/snapshot"
)

// Getter is the part of httpx.Client the export needs.
type Getter interface {
	Get(ctx context.Context, rawURL string) (*httpx.Response, error)
}

type Config struct {
	Client Getter
	// Base URL per API id; the defaults from package endpoints when absent.
	BaseURLs map[string]string
	// Endpoints to fetch; endpoints.Plan when nil.
	Plan []endpoints.Endpoint
	// --skip patterns (see endpoints.Endpoint.Matches).
	Skip     []string
	Parallel int
	Version  string
	Now      func() time.Time
	// Progress, if set, is called once per finished collection request.
	Progress func(snapshot.Coverage)
}

type Result struct {
	Writer   *snapshot.Writer
	Manifest snapshot.Manifest // without files; for summaries
}

// Partial reports whether something could not be fetched. Endpoints the user
// excluded do not count.
func (r Result) Partial() bool {
	for _, c := range r.Manifest.Coverage {
		if c.Status != snapshot.StatusOK && c.Error != errExcluded {
			return true
		}
	}
	return false
}

// ErrUnauthorized means the credentials were rejected outright (HTTP 401).
var ErrUnauthorized = errors.New("the IONOS API rejected the credentials (HTTP 401)")

const errExcluded = "excluded with --skip"

// maxPages stops a misbehaving pagination loop.
const maxPages = 10000

// ids taken from responses become URL path segments and file names, so they
// must look like ids. IONOS uses UUIDs.
var validID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

type fetched struct {
	cov snapshot.Coverage
	doc map[string]any
}

type run struct {
	cfg  Config
	sem  chan struct{}
	mu   sync.Mutex
	done []fetched
}

func Run(ctx context.Context, cfg Config) (*Result, error) {
	if cfg.Plan == nil {
		cfg.Plan = endpoints.Plan
	}
	if cfg.Parallel <= 0 {
		cfg.Parallel = 4
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if err := checkPlan(cfg.Plan); err != nil {
		return nil, err
	}
	x := &run{cfg: cfg, sem: make(chan struct{}, cfg.Parallel)}

	var roots, children []endpoints.Endpoint
	for _, ep := range cfg.Plan {
		if ep.Parent == "" {
			roots = append(roots, ep)
		} else {
			children = append(children, ep)
		}
	}

	// One request first, so bad credentials fail fast instead of 100 times.
	first := x.endpoint(ctx, roots[0])
	if len(first) == 1 && first[0].cov.HTTPStatus == 401 {
		return nil, ErrUnauthorized
	}
	x.parallel(ctx, roots[1:], nil)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	parents := map[string]fetched{}
	for _, f := range x.done {
		if f.cov.Path == f.cov.Endpoint {
			parents[f.cov.API+" "+f.cov.Path] = f
		}
	}
	x.parallel(ctx, children, parents)
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	m := snapshot.Manifest{
		CreatedAt: cfg.Now().UTC().Truncate(time.Second),
		Generator: snapshot.Generator{Name: "ionos-export", Version: cfg.Version},
	}
	used := map[string]bool{}
	for _, ep := range cfg.Plan {
		used[ep.API] = true
	}
	for _, a := range endpoints.APIs {
		if used[a.ID] {
			m.APIs = append(m.APIs, snapshot.API{ID: a.ID, Name: a.Name, Version: a.Version, BaseURL: x.base(a.ID)})
		}
	}
	for _, f := range x.done {
		if f.cov.API == endpoints.CloudAPI && f.cov.Path == "/contracts" && f.doc != nil {
			m.Contract = contract(f.doc)
		}
	}
	// Goroutines finish in any order; the snapshot must not depend on it.
	sort.Slice(x.done, func(i, j int) bool {
		a, b := x.done[i].cov, x.done[j].cov
		return a.API+" "+a.Path+" "+a.Error < b.API+" "+b.Path+" "+b.Error
	})
	w := snapshot.NewWriter(m)
	for _, f := range x.done {
		if f.doc != nil {
			if err := w.AddJSON(f.cov.File, f.doc); err != nil {
				return nil, err
			}
		}
		w.AddCoverage(f.cov)
		m.Coverage = append(m.Coverage, f.cov)
	}
	return &Result{Writer: w, Manifest: m}, nil
}

func checkPlan(plan []endpoints.Endpoint) error {
	if len(plan) == 0 || plan[0].Parent != "" {
		return errors.New("plan must start with a top-level endpoint")
	}
	tops := map[string]bool{}
	for _, ep := range plan {
		if _, ok := endpoints.FindAPI(ep.API); !ok {
			return fmt.Errorf("%s: unknown API %q", ep.Path, ep.API)
		}
		if ep.Parent == "" {
			if ep.Params() != 0 {
				return fmt.Errorf("%s: path parameters need a parent", ep.Path)
			}
			tops[ep.API+" "+ep.Path] = true
		}
	}
	for _, ep := range plan {
		if ep.Parent != "" && (!tops[ep.API+" "+ep.Parent] || ep.Params() != 1) {
			return fmt.Errorf("%s: parent %s must be a top-level endpoint of the same API, and the path must have one parameter", ep.Path, ep.Parent)
		}
	}
	return nil
}

func (x *run) base(api string) string {
	if b, ok := x.cfg.BaseURLs[api]; ok {
		return b
	}
	a, _ := endpoints.FindAPI(api)
	return a.BaseURL
}

// parallel fetches the endpoints, children once per parent item.
func (x *run) parallel(ctx context.Context, eps []endpoints.Endpoint, parents map[string]fetched) {
	var wg sync.WaitGroup
	for _, ep := range eps {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if parents == nil {
				x.endpoint(ctx, ep)
				return
			}
			x.children(ctx, ep, parents[ep.API+" "+ep.Parent])
		}()
	}
	wg.Wait()
}

func (x *run) endpoint(ctx context.Context, ep endpoints.Endpoint) []fetched {
	if x.excluded(ep) {
		return []fetched{x.record(placeholder(ep, snapshot.StatusSkipped, errExcluded), nil)}
	}
	return []fetched{x.fetch(ctx, ep, ep.Path)}
}

func (x *run) children(ctx context.Context, ep endpoints.Endpoint, parent fetched) {
	switch {
	case x.excluded(ep):
		x.record(placeholder(ep, snapshot.StatusSkipped, errExcluded), nil)
		return
	case parent.doc == nil:
		why := "the parent was not fetched"
		if parent.cov.Status != "" {
			why = fmt.Sprintf("%s was %s", ep.Parent, parent.cov.Status)
		}
		if parent.cov.Error == errExcluded {
			why = errExcluded
		}
		x.record(placeholder(ep, snapshot.StatusSkipped, "needs "+ep.Parent+": "+why), nil)
		return
	}
	var wg sync.WaitGroup
	for _, item := range items(parent.doc) {
		obj, _ := item.(map[string]any)
		id, _ := obj["id"].(string)
		if !validID.MatchString(id) {
			x.record(placeholder(ep, snapshot.StatusError, fmt.Sprintf("%s returned an item with an unusable id %q", ep.Parent, id)), nil)
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			x.fetch(ctx, ep, ep.Expand(id))
		}()
	}
	wg.Wait()
}

func (x *run) excluded(ep endpoints.Endpoint) bool {
	for _, p := range x.cfg.Skip {
		if ep.Matches(p) {
			return true
		}
	}
	return false
}

func placeholder(ep endpoints.Endpoint, status, msg string) snapshot.Coverage {
	return snapshot.Coverage{API: ep.API, Endpoint: ep.Path, Path: ep.Path, Query: ep.Query, Status: status, Error: msg}
}

func (x *run) record(cov snapshot.Coverage, doc map[string]any) fetched {
	f := fetched{cov, doc}
	x.mu.Lock()
	x.done = append(x.done, f)
	x.mu.Unlock()
	if x.cfg.Progress != nil {
		x.cfg.Progress(cov)
	}
	return f
}

// fetch lists one collection, following pagination, and records the outcome.
func (x *run) fetch(ctx context.Context, ep endpoints.Endpoint, path string) fetched {
	x.sem <- struct{}{}
	defer func() { <-x.sem }()

	cov := snapshot.Coverage{API: ep.API, Endpoint: ep.Path, Path: path, Query: ep.Query}
	fail := func(status string, http int, msg string) fetched {
		cov.Status, cov.HTTPStatus, cov.Error = status, http, msg
		return x.record(cov, nil)
	}
	query, err := url.ParseQuery(ep.Query)
	if err != nil {
		return fail(snapshot.StatusError, 0, err.Error())
	}

	var doc map[string]any
	var all []any
	for page := 0; ; page++ {
		if page == maxPages {
			return fail(snapshot.StatusError, cov.HTTPStatus, fmt.Sprintf("more than %d pages", maxPages))
		}
		u := x.base(ep.API) + path
		if q := query.Encode(); q != "" {
			u += "?" + q
		}
		resp, err := x.cfg.Client.Get(ctx, u)
		if err != nil {
			return fail(snapshot.StatusError, 0, err.Error())
		}
		cov.Pages++
		cov.HTTPStatus = resp.Status
		switch {
		case resp.Status == 401 || resp.Status == 403:
			return fail(snapshot.StatusForbidden, resp.Status, resp.Error)
		case resp.Status == 404:
			return fail(snapshot.StatusNotFound, resp.Status, resp.Error)
		case resp.Status < 200 || resp.Status > 299:
			return fail(snapshot.StatusError, resp.Status, resp.Error)
		}
		var body map[string]any
		dec := json.NewDecoder(bytes.NewReader(resp.Body))
		dec.UseNumber()
		if err := dec.Decode(&body); err != nil || body == nil {
			return fail(snapshot.StatusError, resp.Status, "response is not a JSON object")
		}
		got, isList := body["items"].([]any)
		if doc == nil {
			doc = body
		}
		all = append(all, got...)

		// Pages are requested by offset rather than by following
		// _links.next, which could point anywhere.
		next, _ := asMap(body["_links"])["next"].(string)
		if !isList || next == "" || len(got) == 0 {
			break
		}
		offset, _ := number(body["offset"])
		limit, _ := number(body["limit"])
		if limit <= 0 {
			limit = int64(len(got))
		}
		query.Set("offset", strconv.FormatInt(offset+int64(len(got)), 10))
		query.Set("limit", strconv.FormatInt(limit, 10))
	}

	if _, isList := doc["items"].([]any); isList {
		if all == nil {
			all = []any{}
		}
		doc["items"] = all
		n := len(all)
		cov.Items = &n
		if _, paged := doc["_links"]; paged {
			doc["offset"], doc["limit"], doc["_links"] = 0, n, map[string]any{}
		}
	}
	cov.Status = snapshot.StatusOK
	cov.File = snapshot.RawFile(ep.API, path)
	return x.record(cov, doc)
}

func contract(doc map[string]any) *snapshot.Contract {
	list := items(doc)
	if len(list) == 0 {
		return nil
	}
	props := asMap(asMap(list[0])["properties"])
	n, ok := number(props["contractNumber"])
	if !ok {
		return nil
	}
	owner, _ := props["owner"].(string)
	return &snapshot.Contract{Number: n, Owner: owner}
}

func items(doc map[string]any) []any {
	list, _ := doc["items"].([]any)
	return list
}

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func number(v any) (int64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	i, err := n.Int64()
	return i, err == nil
}
