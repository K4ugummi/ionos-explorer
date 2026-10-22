package server

import (
	"fmt"
	"net/http"
	"strings"
)

// Probes for Docker and Kubernetes, at the root whatever the base path:
// /healthz answers while the process serves, /readyz while it can serve
// users. No login and no Host check (a probe uses the container's address),
// and nothing in the answer but ok or a short reason; the details go to the
// log, once per change.

func isProbe(path string) bool { return path == "/healthz" || path == "/readyz" }

func (s *Server) probe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	if r.URL.Path == "/readyz" {
		if why := s.ready(); why != "" {
			w.WriteHeader(http.StatusServiceUnavailable)
			fmt.Fprintln(w, "not ready:", why)
			return
		}
	}
	fmt.Fprintln(w, "ok")
}

// Readier is an Authenticator that can tell whether it works (its identity
// provider answered, say); readiness and the login screen ask it. Ready
// must not block.
type Readier interface{ Ready() error }

// ready says why the server cannot serve users ("" if it can) and logs
// when that changes.
func (s *Server) ready() string {
	why, detail := s.readiness()
	s.mu.Lock()
	changed := why != s.notReady
	s.notReady = why
	s.mu.Unlock()
	switch {
	case !changed:
	case why == "":
		s.log.Print("Ready again.")
	case detail == "":
		s.log.Error("Not ready: " + why + ".")
	default:
		s.log.Error("Not ready: " + why + ": " + detail)
	}
	return why
}

func (s *Server) readiness() (why, detail string) {
	s.mu.Lock()
	closed := s.closed
	s.mu.Unlock()
	if closed {
		return "shutting down", ""
	}
	h := s.opts.Hosted
	if h == nil {
		return "", ""
	}
	if h.Users != nil {
		if err := h.Users.Check(); err != nil {
			return "the user accounts cannot be read or written", err.Error()
		}
	}
	if h.History != nil {
		if err := h.History.Check(); err != nil {
			return "the snapshot history cannot be written", err.Error()
		}
	}
	// Users can log in when local users work (checked above) or one login
	// provider does; one that does not is shown unavailable on the login
	// screen and does not block the others.
	if h.Users != nil {
		return "", ""
	}
	var errs []string
	for _, a := range h.Auth {
		rd, ok := a.(Readier)
		if !ok {
			return "", ""
		}
		err := rd.Ready()
		if err == nil {
			return "", ""
		}
		errs = append(errs, a.Label()+": "+err.Error())
	}
	return "no login provider works", strings.Join(errs, "; ")
}
