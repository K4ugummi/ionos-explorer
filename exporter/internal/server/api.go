package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/K4ugummi/ionos-explorer/exporter/internal/export"
	"github.com/K4ugummi/ionos-explorer/exporter/internal/history"
	"github.com/K4ugummi/ionos-explorer/exporter/internal/httpx"
	"github.com/K4ugummi/ionos-explorer/exporter/internal/snapshot"
)

// Status is what GET /api/status answers.
type Status struct {
	App       string `json:"app"`
	Version   string `json:"version"`
	TokenHeld bool   `json:"tokenHeld"`
	// When a held token is dropped for not being used.
	TokenForgetAt *time.Time `json:"tokenForgetAt,omitempty"`
	Fetch         *Fetch     `json:"fetch,omitempty"`
	// Hosted mode: who is logged in, whether an admin, whether a local user
	// (who can change their password) and must do so before anything else.
	User               string `json:"user,omitempty"`
	Admin              bool   `json:"admin,omitempty"`
	LocalUser          bool   `json:"localUser,omitempty"`
	MustChangePassword bool   `json:"mustChangePassword,omitempty"`
	// Hosted mode: fetched snapshots are kept in the user's history.
	History bool `json:"history,omitempty"`
	// Local users' second factor: set up; can be set up here; must be set
	// up before anything else.
	TOTP           bool `json:"totp,omitempty"`
	TOTPAvailable  bool `json:"totpAvailable,omitempty"`
	MustEnrollTOTP bool `json:"mustEnrollTotp,omitempty"`
	TOTPRequired   bool `json:"totpRequired,omitempty"`
}

// Fetch is the state of the last fetch.
type Fetch struct {
	State string `json:"state"` // running, done, failed, cancelled
	// Collection requests finished and planned so far (the plan grows once
	// the top-level collections are known), and how many could not be read.
	Done        int        `json:"done"`
	Total       int        `json:"total"`
	Problems    int        `json:"problems"`
	Error       string     `json:"error,omitempty"`
	ResultReady bool       `json:"resultReady"`
	Size        int        `json:"size,omitempty"`
	StartedAt   time.Time  `json:"startedAt"`
	FinishedAt  *time.Time `json:"finishedAt,omitempty"`
	// The snapshot's ID in the history, or why it could not be stored there.
	HistoryID    string `json:"historyId,omitempty"`
	HistoryError string `json:"historyError,omitempty"`
}

const (
	stateRunning   = "running"
	stateDone      = "done"
	stateFailed    = "failed"
	stateCancelled = "cancelled"
)

type job struct {
	Fetch
	cancel context.CancelFunc
}

// fetchRequest is the body of POST /api/fetch.
type fetchRequest struct {
	// Token replaces the held one; empty uses the held one.
	Token string `json:"token"`
	// Keep holds the token for later fetches (until Forget, exit, 401 or
	// ForgetAfter); false drops it once this fetch ends.
	Keep           bool     `json:"keep"`
	Skip           []string `json:"skip"`
	ContractNumber string   `json:"contractNumber"`
}

var (
	skipPattern     = regexp.MustCompile(`^[A-Za-z0-9/{}_.-]{1,100}$`)
	contractPattern = regexp.MustCompile(`^[0-9]{1,20}$`)
)

// api answers the routes below /api; path is below the base path.
func (s *Server) api(w http.ResponseWriter, r *http.Request, path string) {
	// Same-origin only, also for reads: the answers are confidential.
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" {
		s.fail(w, http.StatusForbidden, "cross-site request refused")
		return
	}
	if s.opts.Hosted != nil && s.publicAPI(w, r, path) {
		return
	}
	ss := s.session(r)
	if ss == nil || !same(r.Header.Get(Header), ss.key) {
		if s.opts.Hosted != nil {
			s.fail(w, http.StatusUnauthorized, "no session: log in again")
		} else {
			s.fail(w, http.StatusUnauthorized, "no session: open the link ionos-explorer printed")
		}
		return
	}
	route := r.Method + " " + path
	s.mu.Lock()
	mustChange, mustEnroll := ss.mustChange, ss.mustEnroll
	s.mu.Unlock()
	if mustChange && route != "GET /api/status" && route != "POST /api/password" && route != "POST /api/logout" {
		s.fail(w, http.StatusForbidden, "change your password first")
		return
	}
	if mustEnroll && route != "GET /api/status" && route != "POST /api/totp/begin" && route != "POST /api/totp/enable" && route != "POST /api/logout" {
		s.fail(w, http.StatusForbidden, "set up two-factor authentication first")
		return
	}
	if r.Method == http.MethodGet {
		switch {
		case route == "GET /api/status":
			s.json(w, http.StatusOK, s.status(ss))
		case route == "GET /api/users":
			s.listUsers(w, ss)
		case route == "GET /api/history":
			s.listHistory(w, r, ss)
		case strings.HasPrefix(route, "GET /api/history/"):
			s.historySnapshot(w, ss, strings.TrimPrefix(route, "GET /api/history/"))
		default:
			s.fail(w, http.StatusNotFound, "not found")
		}
		return
	}
	body, ok := s.postBody(w, r)
	// The body may hold the token or a password: overwritten once handled.
	defer clear(body)
	if !ok {
		return
	}
	if strings.HasPrefix(route, "POST /api/users/") {
		s.changeUser(w, r, ss, strings.TrimPrefix(route, "POST /api/users/"), body)
		return
	}
	switch route {
	case "POST /api/fetch":
		s.startFetch(w, ss, body)
	case "POST /api/fetch/cancel":
		s.mu.Lock()
		if ss.job != nil && ss.job.State == stateRunning {
			ss.job.cancel()
		}
		s.mu.Unlock()
		s.json(w, http.StatusOK, s.status(ss))
	case "POST /api/fetch/result":
		s.takeResult(w, ss)
	case "POST /api/forget":
		s.mu.Lock()
		if ss.job != nil && ss.job.State == stateRunning {
			ss.job.cancel()
		}
		if ss.token != nil {
			s.logf(ss, "Token forgotten.")
		}
		s.dropToken(ss)
		s.mu.Unlock()
		s.json(w, http.StatusOK, s.status(ss))
	case "POST /api/logout":
		if s.opts.Hosted == nil {
			s.fail(w, http.StatusNotFound, "not found")
			return
		}
		s.mu.Lock()
		s.drop(ss, "Logged out.")
		user, auth := ss.user, ss.auth
		s.mu.Unlock()
		gone := s.cookie("")
		gone.MaxAge = -1
		http.SetCookie(w, gone)
		next := s.pub.base + "/"
		// Logged in at an identity provider: logged out there too, then back.
		if l, ok := auth.(Logouter); ok {
			if u := l.LogoutURL(user, s.pub.String()+"/"); u != "" {
				next = u
			}
		}
		s.json(w, http.StatusOK, map[string]string{"app": App, "next": next})
	case "POST /api/password":
		s.changePassword(w, r, ss, body)
	case "POST /api/logout-others":
		s.logoutOthers(w, ss)
	case "POST /api/history/delete":
		s.deleteHistory(w, ss, body)
	case "POST /api/totp/begin":
		s.beginTOTP(w, ss)
	case "POST /api/totp/enable":
		s.enableTOTP(w, r, ss, body)
	case "POST /api/totp/disable":
		s.disableTOTP(w, r, ss, body)
	case "POST /api/totp/recovery":
		s.recoveryCodes(w, r, ss, body)
	default:
		s.fail(w, http.StatusNotFound, "not found")
	}
}

// postBody checks a POST (method, Origin, JSON) and reads its body, or
// answers the error.
func (s *Server) postBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	if r.Method != http.MethodPost {
		s.fail(w, http.StatusMethodNotAllowed, "method not allowed")
		return nil, false
	}
	origin := "http://" + r.Host
	if s.opts.Hosted != nil {
		origin = s.pub.origin
	}
	if r.Header.Get("Origin") != origin {
		s.fail(w, http.StatusForbidden, "cross-origin request refused")
		return nil, false
	}
	if ct, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); ct != "application/json" {
		s.fail(w, http.StatusUnsupportedMediaType, "send JSON")
		return nil, false
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		clear(body)
		s.fail(w, http.StatusRequestEntityTooLarge, "request too large")
		return nil, false
	}
	return body, true
}

func (s *Server) json(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) fail(w http.ResponseWriter, status int, msg string) {
	s.json(w, status, map[string]string{"app": App, "error": msg})
}

func (s *Server) status(ss *session) Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.statusLocked(ss)
}

// statusLocked is status() for callers holding s.mu.
func (s *Server) statusLocked(ss *session) Status {
	st := Status{App: App, Version: s.opts.Version, TokenHeld: ss.token != nil, User: ss.user.Name, Admin: ss.user.Admin,
		LocalUser: ss.userID != "", MustChangePassword: ss.mustChange, History: s.history() != nil,
		TOTP: ss.totp, TOTPAvailable: ss.userID != "" && s.totpAvailable(), MustEnrollTOTP: ss.mustEnroll,
		TOTPRequired: ss.userID != "" && s.opts.Hosted.TOTP == TOTPRequired}
	if ss.token != nil && s.opts.ForgetAfter > 0 && !ss.lastUse.IsZero() {
		at := ss.lastUse.Add(s.opts.ForgetAfter)
		st.TokenForgetAt = &at
	}
	if ss.job != nil {
		f := ss.job.Fetch
		f.ResultReady = ss.result != nil
		if f.ResultReady {
			f.Size = len(ss.result)
		}
		st.Fetch = &f
	}
	return st
}

// validToken accepts what an API token or a pasted one looks like: no
// spaces or control characters inside, not absurdly long.
func validToken(t string) bool {
	if t == "" || len(t) > 16<<10 {
		return false
	}
	for _, r := range t {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func (s *Server) startFetch(w http.ResponseWriter, ss *session, body []byte) {
	var req fetchRequest
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		s.fail(w, http.StatusBadRequest, "malformed request")
		return
	}
	token := strings.TrimSpace(req.Token)
	if token != "" && !validToken(token) {
		s.fail(w, http.StatusBadRequest, "that does not look like an API token (spaces or control characters inside)")
		return
	}
	if len(req.Skip) > 50 {
		s.fail(w, http.StatusBadRequest, "too many skip entries")
		return
	}
	var skip []string
	for _, p := range req.Skip {
		if p = strings.TrimSpace(p); p == "" {
			continue
		}
		if !skipPattern.MatchString(p) {
			s.fail(w, http.StatusBadRequest, "skip: use endpoint paths, path prefixes (/um) or API ids (vpn)")
			return
		}
		skip = append(skip, p)
	}
	if req.ContractNumber != "" && !contractPattern.MatchString(req.ContractNumber) {
		s.fail(w, http.StatusBadRequest, "the contract number is digits only")
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case s.closed:
		s.fail(w, http.StatusServiceUnavailable, errClosed.Error())
		return
	case ss.gone:
		s.fail(w, http.StatusUnauthorized, "no session: log in again")
		return
	case ss.job != nil && ss.job.State == stateRunning:
		s.fail(w, http.StatusConflict, "a fetch is already running")
		return
	}
	if token != "" {
		s.dropToken(ss)
		ss.token = []byte(token)
	}
	if ss.token == nil {
		s.fail(w, http.StatusBadRequest, "enter an API token")
		return
	}
	// Checked after taking the token: Keep holds it for the next try.
	if h := s.opts.Hosted; h != nil && s.running >= h.MaxFetches {
		ss.keep = req.Keep
		if ss.keep {
			s.touch(ss)
		} else {
			s.dropToken(ss)
		}
		s.fail(w, http.StatusTooManyRequests, fmt.Sprintf("%d fetches are running, try again in a minute", s.running))
		return
	}
	ss.keep = req.Keep
	clear(ss.result) // an untaken result of an earlier fetch
	ss.result = nil

	creds := httpx.Credentials{Token: string(ss.token)}
	client := httpx.New(httpx.Options{
		Credentials:    creds,
		Hosts:          s.apiHosts,
		UserAgent:      "ionos-explorer/" + s.opts.Version,
		ContractNumber: req.ContractNumber,
		Backoff:        s.opts.Backoff,
	})
	ctx, cancel := context.WithCancel(context.Background())
	j := &job{Fetch: Fetch{State: stateRunning, StartedAt: time.Now().UTC()}, cancel: cancel}
	ss.job = j
	s.running++
	s.logf(ss, "Fetching from %s…", strings.Join(s.apiHosts, ", "))
	go s.run(ctx, ss, j, client, creds, skip)
	s.json(w, http.StatusAccepted, s.statusLocked(ss))
}

func (s *Server) run(ctx context.Context, ss *session, j *job, client *httpx.Client, creds httpx.Credentials, skip []string) {
	defer j.cancel()
	start := time.Now()
	res, err := export.Run(ctx, export.Config{
		Client:    client,
		BaseURLs:  s.bases,
		Skip:      skip,
		Version:   s.opts.Version,
		Generator: App,
		Planned: func(n int) {
			s.mu.Lock()
			j.Total += n
			s.mu.Unlock()
		},
		Progress: func(c snapshot.Coverage) {
			s.mu.Lock()
			j.Done++
			switch c.Status {
			case snapshot.StatusForbidden, snapshot.StatusNotFound, snapshot.StatusError:
				j.Problems++
			}
			s.mu.Unlock()
		},
	})
	var data []byte
	if err == nil {
		var buf bytes.Buffer
		if err = res.Writer.WriteTo(&buf, snapshot.Options{}); err == nil {
			data = buf.Bytes()
		}
	}
	// Into the history before it is handed out (not while holding s.mu:
	// encrypting and writing take a moment).
	var stored history.Entry
	var storeErr error
	if hs := s.history(); err == nil && hs != nil {
		s.mu.Lock()
		subject, gone := ss.user.Subject, ss.gone || s.closed
		s.mu.Unlock()
		if !gone {
			stored, storeErr = hs.Put(subject, data, historyMeta(res, s.opts.Version))
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.running--
	now := time.Now().UTC()
	j.FinishedAt = &now
	took := time.Since(start).Round(100 * time.Millisecond)
	switch {
	case s.closed:
		j.State, j.Error = stateCancelled, errClosed.Error()
		clear(data)
	case ss.gone:
		j.State, j.Error = stateCancelled, "the session ended"
		clear(data)
	case errors.Is(err, context.Canceled):
		j.State = stateCancelled
		s.logf(ss, "Fetch cancelled after %s.", took)
	case errors.Is(err, export.ErrUnauthorized):
		j.State, j.Error = stateFailed, "The IONOS API rejected the token (HTTP 401). Check it and enter it again."
		s.dropToken(ss) // useless; ask for it again
		s.logf(ss, "Fetch failed: the API rejected the token.")
	case err != nil:
		// Not expected to name a secret; scrubbed all the same.
		j.State, j.Error = stateFailed, creds.Scrub(err.Error())
		s.logf(ss, "Fetch failed: %s", j.Error)
	default:
		j.State = stateDone
		ss.result, ss.resultAt = data, s.now()
		s.logf(ss, "Fetched %d collections in %s (%d could not be read), %d KB in memory.", j.Done, took, j.Problems, len(data)>>10)
		switch {
		case stored.ID != "":
			j.HistoryID = stored.ID
			s.logf(ss, "Stored in the history, %d KB encrypted.", stored.Stored>>10)
		case errors.Is(storeErr, history.ErrQuota):
			j.HistoryError = storeErr.Error()
			s.logf(ss, "Not stored in the history: the user's quota is used up.")
		case storeErr != nil:
			j.HistoryError = "It could not be stored in your history; the server log says why."
			s.log.Error(fmt.Sprintf("History: storing a snapshot of session %s failed: %v", ss.id[:8], storeErr))
		}
	}
	if ss.token != nil {
		if ss.keep {
			s.touch(ss)
		} else {
			s.dropToken(ss)
		}
	}
}

// takeResult hands the snapshot over once and forgets it.
func (s *Server) takeResult(w http.ResponseWriter, ss *session) {
	s.mu.Lock()
	data := ss.result
	ss.result = nil
	s.mu.Unlock()
	if data == nil {
		s.fail(w, http.StatusNotFound, "no fetched snapshot waiting")
		return
	}
	defer clear(data)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
	s.logf(ss, "Snapshot handed to the browser; dropped here.")
}

// touch marks the token as used and (re)starts the idle timer. Holds s.mu.
func (s *Server) touch(ss *session) {
	ss.lastUse = time.Now()
	if s.opts.ForgetAfter <= 0 {
		return
	}
	if ss.timer != nil {
		ss.timer.Stop()
	}
	ss.timer = time.AfterFunc(s.opts.ForgetAfter, func() { s.idle(ss) })
}

func (s *Server) idle(ss *session) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ss.token == nil {
		return
	}
	if ss.job != nil && ss.job.State == stateRunning {
		return // run() touches it when done
	}
	if time.Since(ss.lastUse) >= s.opts.ForgetAfter {
		s.dropToken(ss)
		s.logf(ss, "Token forgotten after %s unused.", s.opts.ForgetAfter)
	}
}

// dropToken overwrites and forgets the held token. Copies in the HTTP
// client's header string cannot be overwritten (Go strings are immutable);
// they become garbage once the fetch ends. Holds s.mu.
func (s *Server) dropToken(ss *session) {
	clear(ss.token)
	ss.token = nil
	if ss.timer != nil {
		ss.timer.Stop()
		ss.timer = nil
	}
}
