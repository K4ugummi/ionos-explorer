// Package fakeapi serves a snapshot back the way the IONOS API would, so the
// exporter can be tested end to end without an account.
package fakeapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"sync/atomic"

	"ionos-explorer/exporter/internal/endpoints"
	"ionos-explorer/exporter/internal/fixture"
	"ionos-explorer/exporter/internal/snapshot"
)

// Prefix is where the server answers for an API: see endpoints.API.Prefix.
func Prefix(api string) string {
	a, _ := endpoints.FindAPI(api)
	return a.Prefix()
}

// Server answers with the snapshot's raw files, paginated, and with error
// bodies for what the snapshot recorded as forbidden.
type Server struct {
	Snap     *snapshot.Snapshot
	Token    string // expected bearer token
	PageSize int
	Requests atomic.Int64
	// Optional hook; returning true means the request was handled.
	Intercept func(w http.ResponseWriter, r *http.Request) bool
	// Errorf reports requests the exporter should never make.
	Errorf func(format string, args ...any)
}

// Demo is the fixture's demo contract.
func Demo() (*snapshot.Snapshot, error) {
	w, err := fixture.Generate(fixture.Options{Seed: 1})
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := w.WriteTo(&buf, snapshot.Options{}); err != nil {
		return nil, err
	}
	return snapshot.Read(&buf)
}

func (f *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.Requests.Add(1)
	if r.Header.Get("Authorization") != "Bearer "+f.Token {
		WriteError(w, 401, "AUTH-1", "Unauthorized")
		return
	}
	if r.Method != http.MethodGet {
		f.Errorf("%s %s", r.Method, r.URL)
	}
	if f.Intercept != nil && f.Intercept(w, r) {
		return
	}
	for _, c := range f.Snap.Manifest.Coverage {
		if r.URL.Path != Prefix(c.API)+c.Path {
			continue
		}
		q := r.URL.Query()
		want, _ := url.ParseQuery(c.Query)
		if q.Get("depth") != want.Get("depth") {
			f.Errorf("%s: depth=%q, want %q", r.URL, q.Get("depth"), want.Get("depth"))
		}
		if c.Status != snapshot.StatusOK {
			WriteError(w, c.HTTPStatus, "", c.Error) // the recorded error includes its code
			return
		}
		var doc map[string]any
		dec := json.NewDecoder(bytes.NewReader(f.Snap.Files[c.File]))
		dec.UseNumber()
		if err := dec.Decode(&doc); err != nil {
			WriteError(w, 500, "FAKE", err.Error())
			return
		}
		if _, paged := doc["_links"]; paged {
			all := doc["items"].([]any)
			offset, _ := strconv.Atoi(q.Get("offset"))
			limit, err := strconv.Atoi(q.Get("limit"))
			if err != nil || limit <= 0 {
				limit = f.PageSize
			}
			offset = min(max(offset, 0), len(all))
			end := min(offset+limit, len(all))
			doc["items"], doc["offset"], doc["limit"] = all[offset:end], offset, limit
			links := map[string]any{"self": "https://api.ionos.com" + r.URL.String()}
			if end < len(all) {
				// The exporter must not follow this.
				links["next"] = "https://evil.example/steal"
			}
			doc["_links"] = links
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(doc)
		return
	}
	WriteError(w, 404, "VDC-5-1", "Resource does not exist")
}

// WriteError writes an IONOS-style error response.
func WriteError(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	m := map[string]any{"message": msg}
	if code != "" {
		m["errorCode"] = code
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"httpStatus": status, "messages": []any{m}})
}
