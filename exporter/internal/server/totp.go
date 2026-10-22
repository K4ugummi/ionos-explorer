package server

import (
	"bytes"
	"errors"
	"net/http"
	"time"

	"github.com/K4ugummi/ionos-explorer/exporter/internal/users"
)

// Two-factor authentication of local users (users/totp.go). A login of an
// account with a second factor takes two requests: the password answers a
// ticket (in memory, 5 minutes, 5 tries, bound to the account), and
// POST /api/login/code with the ticket and a code starts the session.
// Setting one up: begin (a new secret, held in the session for 10
// minutes), then enable with the password and a code from the app.

const (
	ticketTTL    = 5 * time.Minute
	ticketTries  = 5
	maxTickets   = 10000
	enrolmentTTL = 10 * time.Minute
)

// TOTP modes (Hosted.TOTP).
const (
	TOTPOff      = "off"
	TOTPOptional = "optional"
	TOTPRequired = "required"
)

type loginTicket struct {
	userID string
	until  time.Time
	tries  int
}

// totpAvailable reports whether local users can set up a second factor.
func (s *Server) totpAvailable() bool {
	h := s.opts.Hosted
	return h != nil && h.Users != nil && h.TOTP != TOTPOff && h.Users.CanSeal()
}

// newTicket starts the second step of a login. Holds no lock.
func (s *Server) newTicket(userID string) string {
	code := random()
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.tickets) >= maxTickets {
		s.dropTickets(s.now())
	}
	s.tickets[sessionID(code)] = &loginTicket{userID: userID, until: s.now().Add(ticketTTL)}
	return code
}

// dropTickets forgets expired tickets. Holds s.mu.
func (s *Server) dropTickets(now time.Time) {
	for k, t := range s.tickets {
		if !now.Before(t.until) {
			delete(s.tickets, k)
		}
	}
}

// useTicket counts a try of a ticket and answers its account, or false
// when it is unknown, expired or tried too often.
func (s *Server) useTicket(code string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := sessionID(code)
	t := s.tickets[key]
	if code == "" || t == nil || !s.now().Before(t.until) {
		delete(s.tickets, key)
		return "", false
	}
	t.tries++
	if t.tries >= ticketTries {
		delete(s.tickets, key)
	}
	return t.userID, true
}

func (s *Server) endTicket(code string) {
	s.mu.Lock()
	delete(s.tickets, sessionID(code))
	s.mu.Unlock()
}

// loginCode: POST /api/login/code {ticket, code}, the second step.
func (s *Server) loginCode(w http.ResponseWriter, r *http.Request, ticket, code string) {
	id, ok := s.useTicket(ticket)
	if !ok {
		s.fail(w, http.StatusGone, "The login took too long or had too many tries; log in again.")
		return
	}
	u, err := s.opts.Hosted.Users.SecondFactor(id, code)
	switch {
	case errors.Is(err, users.ErrCode):
		s.printf("Wrong second-factor code for %s.", printable(s.username(id)))
		s.fail(w, http.StatusUnauthorized, "Wrong code.")
		return
	case errors.Is(err, users.ErrNoKey):
		s.log.Error("Users: an account with a second factor logs in, but the server has no age identity (IONOS_EXPLORER_AGE_IDENTITY_FILE) to check it.")
		s.fail(w, http.StatusServiceUnavailable, "The server cannot check second factors right now; tell its admin.")
		return
	case err != nil:
		s.userError(w, err)
		return
	}
	s.endTicket(ticket)
	s.loggedIn(w, r, u)
}

func (s *Server) username(id string) string {
	u, _ := s.opts.Hosted.Users.Get(id)
	return u.Username
}

// localUser answers for a session without a local account.
func (s *Server) localUser(w http.ResponseWriter, ss *session) bool {
	if ss.userID == "" {
		s.fail(w, http.StatusNotFound, "only local accounts have a second factor here")
		return false
	}
	return true
}

// beginTOTP: POST /api/totp/begin, a new secret to set up.
func (s *Server) beginTOTP(w http.ResponseWriter, ss *session) {
	if !s.localUser(w, ss) {
		return
	}
	if !s.totpAvailable() {
		s.fail(w, http.StatusNotFound, "two-factor authentication is not offered on this server")
		return
	}
	u, _ := s.opts.Hosted.Users.Get(ss.userID)
	if u.TOTP != "" {
		s.fail(w, http.StatusConflict, "two-factor authentication is on already")
		return
	}
	secret := users.NewTOTPSecret()
	s.mu.Lock()
	clear(ss.pendingTOTP)
	ss.pendingTOTP, ss.pendingUntil = secret, s.now().Add(enrolmentTTL)
	s.mu.Unlock()
	s.json(w, http.StatusOK, map[string]string{"app": App, "key": users.TOTPKey(secret), "uri": users.TOTPURI(secret, u.Username)})
}

// enableTOTP: POST /api/totp/enable {password, code}. Other sessions end.
func (s *Server) enableTOTP(w http.ResponseWriter, r *http.Request, ss *session, body []byte) {
	if !s.localUser(w, ss) {
		return
	}
	var req struct {
		Password string `json:"password"`
		Code     string `json:"code"`
	}
	if decode(body, &req) != nil {
		s.fail(w, http.StatusBadRequest, "malformed request")
		return
	}
	s.mu.Lock()
	if ss.pendingTOTP != nil && !s.now().Before(ss.pendingUntil) {
		clear(ss.pendingTOTP)
		ss.pendingTOTP = nil
	}
	secret := bytes.Clone(ss.pendingTOTP) // a second begin may replace it meanwhile
	s.mu.Unlock()
	defer clear(secret)
	if secret == nil {
		s.fail(w, http.StatusConflict, "start the setup again (it is only kept for 10 minutes)")
		return
	}
	u, codes, err := s.opts.Hosted.Users.EnableTOTP(r.Context(), ss.userID, req.Password, secret, req.Code)
	if err != nil {
		s.userError(w, err)
		return
	}
	s.mu.Lock()
	clear(ss.pendingTOTP)
	ss.pendingTOTP = nil
	ss.epoch, ss.totp, ss.mustEnroll = u.Epoch, true, false
	s.logf(ss, "Second factor set up; other sessions end.")
	st := s.statusLocked(ss)
	s.mu.Unlock()
	s.json(w, http.StatusOK, map[string]any{"app": App, "recoveryCodes": codes, "status": st})
}

// disableTOTP: POST /api/totp/disable {password}; not where it is required.
func (s *Server) disableTOTP(w http.ResponseWriter, r *http.Request, ss *session, body []byte) {
	if !s.localUser(w, ss) {
		return
	}
	if s.opts.Hosted.TOTP == TOTPRequired {
		s.fail(w, http.StatusForbidden, "two-factor authentication is required on this server")
		return
	}
	var req struct {
		Password string `json:"password"`
	}
	if decode(body, &req) != nil {
		s.fail(w, http.StatusBadRequest, "malformed request")
		return
	}
	u, err := s.opts.Hosted.Users.DisableTOTP(r.Context(), ss.userID, req.Password)
	if err != nil {
		s.userError(w, err)
		return
	}
	s.mu.Lock()
	ss.epoch, ss.totp = u.Epoch, false
	s.logf(ss, "Second factor turned off; other sessions end.")
	st := s.statusLocked(ss)
	s.mu.Unlock()
	s.json(w, http.StatusOK, st)
}

// recoveryCodes: POST /api/totp/recovery {password}, new recovery codes.
func (s *Server) recoveryCodes(w http.ResponseWriter, r *http.Request, ss *session, body []byte) {
	if !s.localUser(w, ss) {
		return
	}
	var req struct {
		Password string `json:"password"`
	}
	if decode(body, &req) != nil {
		s.fail(w, http.StatusBadRequest, "malformed request")
		return
	}
	_, codes, err := s.opts.Hosted.Users.NewRecoveryCodes(r.Context(), ss.userID, req.Password)
	if err != nil {
		s.userError(w, err)
		return
	}
	s.logf(ss, "New recovery codes made.")
	s.json(w, http.StatusOK, map[string]any{"app": App, "recoveryCodes": codes})
}
