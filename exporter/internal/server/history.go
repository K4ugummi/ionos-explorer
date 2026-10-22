package server

import (
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"time"

	"github.com/K4ugummi/ionos-explorer/exporter/internal/export"
	"github.com/K4ugummi/ionos-explorer/exporter/internal/history"
	"github.com/K4ugummi/ionos-explorer/exporter/internal/snapshot"
)

// The history API of hosted mode: a user's own fetched snapshots, kept
// encrypted on the volume (internal/history). Every call works on the
// caller's own history; the store takes the identity, never a path, and
// IDs are checked against a pattern before they name a file.

// HistoryList is what GET /api/history answers.
type HistoryList struct {
	App     string          `json:"app"`
	Entries []history.Entry `json:"entries"`
	// Used is what the user's history takes; Quota the most it may (0: no limit).
	Used  int64 `json:"used"`
	Quota int64 `json:"quota,omitempty"`
}

// pruneEvery is how often the retention runs over all histories, besides
// after each store.
const pruneEvery = time.Hour

var historyContract = regexp.MustCompile(`^(unknown|[0-9]{1,20})$`)

// history is the store, nil without one (local mode, or hosted without a key).
func (s *Server) history() *history.Store {
	if s.opts.Hosted == nil {
		return nil
	}
	return s.opts.Hosted.History
}

// historyMeta is what the list shows of a fetched snapshot.
func historyMeta(res *export.Result, version string) history.Meta {
	m := history.Meta{CreatedAt: res.Manifest.CreatedAt, Collections: len(res.Manifest.Coverage), Partial: res.Partial(), Version: version}
	if c := res.Manifest.Contract; c != nil {
		m.Contract = c.Number
	}
	for _, c := range res.Manifest.Coverage {
		switch c.Status {
		case snapshot.StatusForbidden, snapshot.StatusNotFound, snapshot.StatusError:
			m.Problems++
		}
	}
	return m
}

// historyOf is the store and the caller's identity, or answers why not.
func (s *Server) historyOf(w http.ResponseWriter, ss *session) (*history.Store, string, bool) {
	hs := s.history()
	s.mu.Lock()
	subject := ss.user.Subject
	s.mu.Unlock()
	if hs == nil || subject == "" {
		s.fail(w, http.StatusNotFound, "there is no snapshot history on this server")
		return nil, "", false
	}
	return hs, subject, true
}

func (s *Server) listHistory(w http.ResponseWriter, r *http.Request, ss *session) {
	hs, subject, ok := s.historyOf(w, ss)
	if !ok {
		return
	}
	contract := r.URL.Query().Get("contract")
	if contract != "" && !historyContract.MatchString(contract) {
		s.fail(w, http.StatusBadRequest, "the contract number is digits only")
		return
	}
	entries, err := hs.List(subject, contract)
	if err != nil {
		s.historyFailed(w, ss, "listing", err)
		return
	}
	used, err := hs.Usage(subject)
	if err != nil {
		s.historyFailed(w, ss, "listing", err)
		return
	}
	s.json(w, http.StatusOK, HistoryList{App: App, Entries: entries, Used: used, Quota: hs.MaxBytes()})
}

// historySnapshot answers a snapshot of the caller's history, decrypted here:
// the browser never holds the server's key.
func (s *Server) historySnapshot(w http.ResponseWriter, ss *session, id string) {
	hs, subject, ok := s.historyOf(w, ss)
	if !ok {
		return
	}
	data, err := hs.Get(subject, id)
	if errors.Is(err, history.ErrNotFound) {
		s.fail(w, http.StatusNotFound, err.Error())
		return
	}
	if err != nil {
		s.historyFailed(w, ss, "reading", err)
		return
	}
	defer clear(data)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (s *Server) deleteHistory(w http.ResponseWriter, ss *session, body []byte) {
	hs, subject, ok := s.historyOf(w, ss)
	if !ok {
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if decode(body, &req) != nil {
		s.fail(w, http.StatusBadRequest, "malformed request")
		return
	}
	err := hs.Delete(subject, req.ID)
	if errors.Is(err, history.ErrNotFound) {
		s.fail(w, http.StatusNotFound, err.Error())
		return
	}
	if err != nil {
		s.historyFailed(w, ss, "deleting", err)
		return
	}
	s.logf(ss, "Deleted a snapshot from the history.")
	s.json(w, http.StatusOK, map[string]string{"app": App})
}

// historyFailed logs a failure of the store and answers without its details.
func (s *Server) historyFailed(w http.ResponseWriter, ss *session, doing string, err error) {
	s.log.Error(fmt.Sprintf("History: %s for session %s failed: %v", doing, ss.id[:8], err))
	s.fail(w, http.StatusInternalServerError, "the history cannot be read right now; the server log says why")
}

// removeHistory deletes a deleted local user's history.
func (s *Server) removeHistory(userID string) {
	hs := s.history()
	if hs == nil {
		return
	}
	if err := hs.RemoveUser("local:" + userID); err != nil {
		s.log.Error(fmt.Sprintf("History: removing a deleted user's history failed: %v", err))
	}
}

// prune applies the retention to every history (the janitor, hourly).
func (s *Server) prune() {
	hs := s.history()
	if hs == nil {
		return
	}
	n, err := hs.Prune()
	switch {
	case err != nil:
		s.log.Error(fmt.Sprintf("History: applying the retention failed: %v", err))
	case n > 0:
		s.printf("History: %d snapshots past the retention deleted.", n)
	}
}
