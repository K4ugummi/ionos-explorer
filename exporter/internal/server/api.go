package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"

	"ionos-explorer/exporter/internal/export"
	"ionos-explorer/exporter/internal/httpx"
	"ionos-explorer/exporter/internal/snapshot"
)

// Status is what GET /api/status answers.
type Status struct {
	App       string `json:"app"`
	Version   string `json:"version"`
	TokenHeld bool   `json:"tokenHeld"`
	// When a held token is dropped for not being used.
	TokenForgetAt *time.Time `json:"tokenForgetAt,omitempty"`
	Fetch         *Fetch     `json:"fetch,omitempty"`
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

func (s *Server) api(w http.ResponseWriter, r *http.Request) {
	// Same-origin only, also for reads: the answers are confidential.
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" {
		s.fail(w, http.StatusForbidden, "cross-site request refused")
		return
	}
	if !s.loggedIn(r) || !same(r.Header.Get(Header), s.key) {
		s.fail(w, http.StatusUnauthorized, "no session: open the link ionos-explorer printed")
		return
	}
	route := r.Method + " " + r.URL.Path
	if r.Method == http.MethodGet {
		if route != "GET /api/status" {
			s.fail(w, http.StatusNotFound, "not found")
			return
		}
		s.json(w, http.StatusOK, s.status())
		return
	}
	if r.Method != http.MethodPost {
		s.fail(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if origin := r.Header.Get("Origin"); origin != "http://"+r.Host {
		s.fail(w, http.StatusForbidden, "cross-origin request refused")
		return
	}
	if ct, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); ct != "application/json" {
		s.fail(w, http.StatusUnsupportedMediaType, "send JSON")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	// The body may hold the token: overwritten once handled.
	defer clear(body)
	if err != nil {
		s.fail(w, http.StatusRequestEntityTooLarge, "request too large")
		return
	}
	switch route {
	case "POST /api/fetch":
		s.startFetch(w, body)
	case "POST /api/fetch/cancel":
		s.mu.Lock()
		if s.job != nil && s.job.State == stateRunning {
			s.job.cancel()
		}
		s.mu.Unlock()
		s.json(w, http.StatusOK, s.status())
	case "POST /api/fetch/result":
		s.takeResult(w)
	case "POST /api/forget":
		s.mu.Lock()
		if s.job != nil && s.job.State == stateRunning {
			s.job.cancel()
		}
		if s.token != nil {
			s.logf("Token forgotten.")
		}
		s.dropToken()
		s.mu.Unlock()
		s.json(w, http.StatusOK, s.status())
	default:
		s.fail(w, http.StatusNotFound, "not found")
	}
}

func (s *Server) json(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) fail(w http.ResponseWriter, status int, msg string) {
	s.json(w, status, map[string]string{"app": App, "error": msg})
}

func (s *Server) status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.statusLocked()
}

// statusLocked is status() for callers holding s.mu.
func (s *Server) statusLocked() Status {
	st := Status{App: App, Version: s.opts.Version, TokenHeld: s.token != nil}
	if s.token != nil && s.opts.ForgetAfter > 0 && !s.lastUse.IsZero() {
		at := s.lastUse.Add(s.opts.ForgetAfter)
		st.TokenForgetAt = &at
	}
	if s.job != nil {
		f := s.job.Fetch
		f.ResultReady = s.result != nil
		if f.ResultReady {
			f.Size = len(s.result)
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

func (s *Server) startFetch(w http.ResponseWriter, body []byte) {
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
	case s.job != nil && s.job.State == stateRunning:
		s.fail(w, http.StatusConflict, "a fetch is already running")
		return
	}
	if token != "" {
		s.dropToken()
		s.token = []byte(token)
	}
	if s.token == nil {
		s.fail(w, http.StatusBadRequest, "enter an API token")
		return
	}
	s.keep = req.Keep
	clear(s.result) // an untaken result of an earlier fetch
	s.result = nil

	creds := httpx.Credentials{Token: string(s.token)}
	client := httpx.New(httpx.Options{
		Credentials:    creds,
		Hosts:          s.apiHosts,
		UserAgent:      "ionos-explorer/" + s.opts.Version,
		ContractNumber: req.ContractNumber,
		Backoff:        s.opts.Backoff,
	})
	ctx, cancel := context.WithCancel(context.Background())
	j := &job{Fetch: Fetch{State: stateRunning, StartedAt: time.Now().UTC()}, cancel: cancel}
	s.job = j
	s.logf("Fetching from %s…", strings.Join(s.apiHosts, ", "))
	go s.run(ctx, j, client, creds, skip)
	s.json(w, http.StatusAccepted, s.statusLocked())
}

func (s *Server) run(ctx context.Context, j *job, client *httpx.Client, creds httpx.Credentials, skip []string) {
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

	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	j.FinishedAt = &now
	took := time.Since(start).Round(100 * time.Millisecond)
	switch {
	case s.closed:
		j.State, j.Error = stateCancelled, errClosed.Error()
	case errors.Is(err, context.Canceled):
		j.State = stateCancelled
		s.logf("Fetch cancelled after %s.", took)
	case errors.Is(err, export.ErrUnauthorized):
		j.State, j.Error = stateFailed, "The IONOS API rejected the token (HTTP 401). Check it and enter it again."
		s.dropToken() // useless; ask for it again
		s.logf("Fetch failed: the API rejected the token.")
	case err != nil:
		// Not expected to name a secret; scrubbed all the same.
		j.State, j.Error = stateFailed, creds.Scrub(err.Error())
		s.logf("Fetch failed: %s", j.Error)
	default:
		j.State = stateDone
		s.result = data
		s.logf("Fetched %d collections in %s (%d could not be read), %d KB in memory.", j.Done, took, j.Problems, len(data)>>10)
	}
	if s.token != nil {
		if s.keep {
			s.touch()
		} else {
			s.dropToken()
		}
	}
}

// takeResult hands the snapshot over once and forgets it.
func (s *Server) takeResult(w http.ResponseWriter) {
	s.mu.Lock()
	data := s.result
	s.result = nil
	s.mu.Unlock()
	if data == nil {
		s.fail(w, http.StatusNotFound, "no fetched snapshot waiting")
		return
	}
	defer clear(data)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
	s.logf("Snapshot handed to the browser; dropped here.")
}

// touch marks the token as used and (re)starts the idle timer. Holds s.mu.
func (s *Server) touch() {
	s.lastUse = time.Now()
	if s.opts.ForgetAfter <= 0 {
		return
	}
	if s.timer != nil {
		s.timer.Stop()
	}
	s.timer = time.AfterFunc(s.opts.ForgetAfter, s.idle)
}

func (s *Server) idle() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.token == nil {
		return
	}
	if s.job != nil && s.job.State == stateRunning {
		return // run() touches it when done
	}
	if time.Since(s.lastUse) >= s.opts.ForgetAfter {
		s.dropToken()
		s.logf("Token forgotten after %s unused.", s.opts.ForgetAfter)
	}
}

// dropToken overwrites and forgets the held token. Copies in the HTTP
// client's header string cannot be overwritten (Go strings are immutable);
// they become garbage once the fetch ends. Holds s.mu.
func (s *Server) dropToken() {
	clear(s.token)
	s.token = nil
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
}
