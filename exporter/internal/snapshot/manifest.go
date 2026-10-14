// Package snapshot implements the .ionx snapshot container shared by the
// exporter and the explorer. See docs/SNAPSHOT_FORMAT.md for the spec.
package snapshot

import "time"

// FormatVersion is bumped on any incompatible change to the container layout
// or the manifest. The explorer refuses snapshots with a newer major version.
const FormatVersion = 1

// ManifestPath is the location of the manifest inside the container.
const ManifestPath = "manifest.json"

// Coverage statuses.
const (
	StatusOK        = "ok"
	StatusForbidden = "forbidden" // 401/403: the exporting user cannot see this
	StatusNotFound  = "not_found" // 404: e.g. product not enabled in this region
	StatusError     = "error"     // anything else (5xx, timeouts, decode errors)
	StatusSkipped   = "skipped"   // deliberately not fetched (filter, dependency failed)
)

type Manifest struct {
	FormatVersion int         `json:"formatVersion"`
	CreatedAt     time.Time   `json:"createdAt"`
	Generator     Generator   `json:"generator"`
	Synthetic     bool        `json:"synthetic"`
	Contract      *Contract   `json:"contract,omitempty"`
	APIs          []API       `json:"apis"`
	Coverage      []Coverage  `json:"coverage"`
	Files         []FileEntry `json:"files"`
}

type Generator struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type Contract struct {
	Number int64  `json:"number"`
	Owner  string `json:"owner,omitempty"`
}

// API describes one upstream API a snapshot contains data from. ID is the
// directory name under raw/, e.g. "cloudapi-v6" or "mariadb-v1-de-txl".
type API struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Version string `json:"version"`
	BaseURL string `json:"baseUrl"`
	Region  string `json:"region,omitempty"`
}

// Coverage records the outcome of one collection request, so consumers can
// tell "no resources" apart from "not allowed to see resources".
type Coverage struct {
	API        string `json:"api"`
	Endpoint   string `json:"endpoint"`
	Path       string `json:"path"`
	Query      string `json:"query,omitempty"`
	Status     string `json:"status"`
	HTTPStatus int    `json:"httpStatus,omitempty"`
	File       string `json:"file,omitempty"`
	Items      *int   `json:"items,omitempty"`
	Pages      int    `json:"pages,omitempty"`
	Error      string `json:"error,omitempty"`
}

type FileEntry struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// RawFile returns the container path for a response of api at apiPath,
// e.g. RawFile("cloudapi-v6", "/datacenters/x/servers") ->
// "raw/cloudapi-v6/datacenters/x/servers.json".
func RawFile(api, apiPath string) string {
	for len(apiPath) > 0 && apiPath[0] == '/' {
		apiPath = apiPath[1:]
	}
	return "raw/" + api + "/" + apiPath + ".json"
}
