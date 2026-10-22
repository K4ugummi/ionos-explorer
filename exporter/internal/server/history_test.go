package server

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"filippo.io/age"

	"github.com/K4ugummi/ionos-explorer/exporter/internal/history"
	"github.com/K4ugummi/ionos-explorer/exporter/internal/users"
)

func newHistory(t *testing.T, dir string, opts history.Options) *history.Store {
	t.Helper()
	id, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	hs, err := history.Open(dir, []*age.X25519Identity{id}, opts)
	if err != nil {
		t.Fatal(err)
	}
	return hs
}

func (h *harness) history(query string) HistoryList {
	h.t.Helper()
	resp, b := h.do(req{path: "/api/history" + query})
	var l HistoryList
	if resp.StatusCode != http.StatusOK || json.Unmarshal(b, &l) != nil {
		h.t.Fatalf("history: %d %s", resp.StatusCode, b)
	}
	return l
}

// fetched fetches and takes the result.
func (h *harness) fetched() (*Fetch, []byte) {
	h.t.Helper()
	if code, body := h.post("/api/fetch", `{"token":"`+token+`","keep":false}`); code != http.StatusAccepted {
		h.t.Fatal(code, body)
	}
	f := h.wait()
	resp, data := h.do(req{method: http.MethodPost, path: "/api/fetch/result", body: "{}"})
	if f.State != stateDone || resp.StatusCode != http.StatusOK {
		h.t.Fatalf("fetch %+v, result %d", f, resp.StatusCode)
	}
	return f, data
}

func TestHostedHistory(t *testing.T) {
	dir := t.TempDir()
	a := startHosted(t, "https://explorer.example", func(o *Options) { o.Hosted.History = newHistory(t, dir, history.Options{}) })
	b := a.client()
	a.hostedLogin("alice")
	b.hostedLogin("bob")
	if !a.status().History {
		t.Fatal("status does not tell about the history")
	}
	f, data := a.fetched()
	if f.HistoryID == "" || f.HistoryError != "" {
		t.Fatalf("not stored: %+v", f)
	}
	l := a.history("")
	if len(l.Entries) != 1 || l.Entries[0].ID != f.HistoryID || l.Used == 0 || l.Entries[0].Collections != f.Total || l.Entries[0].Problems != 2 ||
		!l.Entries[0].Partial || l.Entries[0].Size != int64(len(data)) {
		t.Fatalf("list %+v", l)
	}
	contract := l.Entries[0].Contract
	if len(a.history("?contract="+contract).Entries) != 1 || len(a.history("?contract=1").Entries) != 0 {
		t.Error("contract filter")
	}
	if code := a.code(req{path: "/api/history?contract=../x"}); code != http.StatusBadRequest {
		t.Errorf("bad contract: %d", code)
	}
	resp, got := a.do(req{path: "/api/history/" + f.HistoryID})
	if resp.StatusCode != http.StatusOK || !bytes.Equal(got, data) || resp.Header.Get("Content-Type") != "application/octet-stream" ||
		resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("get: %d, same bytes %v", resp.StatusCode, bytes.Equal(got, data))
	}
	if !strings.Contains(a.log.String(), "Stored in the history") {
		t.Error("no log line")
	}

	// Bob sees nothing of it, whatever he asks for.
	if l := b.history(""); len(l.Entries) != 0 || l.Used != 0 {
		t.Fatalf("bob lists %+v", l)
	}
	for _, id := range []string{f.HistoryID, "..%2F" + f.HistoryID, "../../" + f.HistoryID, "%2e%2e/x", history.Scope("test:alice") + "/" + contract + "/x", "x"} {
		if code := b.code(req{path: "/api/history/" + id}); code != http.StatusNotFound {
			t.Errorf("bob gets %q: %d", id, code)
		}
		body, _ := json.Marshal(map[string]string{"id": id})
		if code, _ := b.post("/api/history/delete", string(body)); code != http.StatusNotFound {
			t.Errorf("bob deletes %q: %d", id, code)
		}
	}
	// Without the key or from elsewhere, as every API call.
	if code := a.code(req{path: "/api/history", noKey: true}); code != http.StatusUnauthorized {
		t.Errorf("no key: %d", code)
	}
	if code := a.code(req{path: "/api/history/" + f.HistoryID, header: map[string]string{"Sec-Fetch-Site": "cross-site"}}); code != http.StatusForbidden {
		t.Errorf("cross-site: %d", code)
	}
	if code := a.code(req{method: http.MethodPost, path: "/api/history/delete", body: `{"id":"` + f.HistoryID + `"}`, header: map[string]string{"Origin": "https://evil.example"}}); code != http.StatusForbidden {
		t.Errorf("cross-origin delete: %d", code)
	}

	// On the volume: hashed scopes, contract numbers, times; age files.
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if strings.Contains(path, "alice") || strings.Contains(path, "bob") {
			t.Errorf("a name on the volume: %s", path)
		}
		if !d.IsDir() {
			b, _ := os.ReadFile(path)
			if !bytes.HasPrefix(b, []byte("age-encryption.org/v1\n")) {
				t.Errorf("%s is not age", path)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	if code, body := a.post("/api/history/delete", `{"id":"`+f.HistoryID+`"}`); code != http.StatusOK {
		t.Fatal(code, body)
	}
	if len(a.history("").Entries) != 0 {
		t.Fatal("deleted, still listed")
	}
	if code, _ := a.post("/api/history/delete", `{"id":"`+f.HistoryID+`"}`); code != http.StatusNotFound {
		t.Errorf("second delete: %d", code)
	}
}

func TestHistoryOff(t *testing.T) {
	local := start(t, nil)
	local.login()
	hosted := startHosted(t, "https://explorer.example", nil)
	hosted.hostedLogin("alice")
	for _, h := range []*harness{local, hosted} {
		if h.status().History {
			t.Error("history in status without one")
		}
		if code := h.code(req{path: "/api/history"}); code != http.StatusNotFound {
			t.Errorf("list: %d", code)
		}
		if f, _ := h.fetched(); f.HistoryID != "" || f.HistoryError != "" {
			t.Errorf("%+v", f)
		}
	}
}

func TestHistoryFullKeepsTheFetch(t *testing.T) {
	a := startHosted(t, "https://explorer.example", func(o *Options) {
		o.Hosted.History = newHistory(t, t.TempDir(), history.Options{MaxBytes: 100})
	})
	a.hostedLogin("alice")
	f, data := a.fetched()
	if f.HistoryID != "" || !strings.Contains(f.HistoryError, "history is full") || len(data) == 0 {
		t.Fatalf("%+v", f)
	}
	if l := a.history(""); len(l.Entries) != 0 || l.Quota != 100 {
		t.Fatalf("%+v", l)
	}
}

func TestDeletedUserLosesHistory(t *testing.T) {
	dir := t.TempDir()
	admin, store := startLocal(t, nil, func(o *Options, _ *users.Store) { o.Hosted.History = newHistory(t, dir, history.Options{}) })
	addUser(t, store, "root", users.RoleAdmin, false)
	carol := addUser(t, store, "carol", users.RoleUser, false)
	user := admin.client()
	admin.passwordLogin("root", password)
	user.passwordLogin("carol", password)
	user.fetched()
	admin.fetched()
	scope := filepath.Join(history.Root(dir), history.Scope("local:"+carol.ID))
	if _, err := os.Stat(scope); err != nil {
		t.Fatal("carol has no history", err)
	}
	if code, body := admin.post("/api/users/delete", `{"id":"`+carol.ID+`"}`); code != http.StatusOK {
		t.Fatal(code, body)
	}
	if _, err := os.Stat(scope); !os.IsNotExist(err) {
		t.Fatal("carol's history is left", err)
	}
	if len(admin.history("").Entries) != 1 {
		t.Fatal("the admin's history went too")
	}
}
