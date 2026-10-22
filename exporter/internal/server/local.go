package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/K4ugummi/ionos-explorer/exporter/internal/users"
)

// The API of hosted mode's login and of local user accounts. Logins are
// JSON POSTs from the page (the CSP keeps form-action 'none'), with the
// same Origin, content type and size checks as every other call, plus the
// header (any value before a session exists).

// LoginMethods is what GET /api/login-methods answers, without a session.
type LoginMethods struct {
	App string `json:"app"`
	// Local: username and password; Setup: no account yet (the first admin
	// comes from the link in the server's log).
	Local     bool       `json:"local"`
	Setup     bool       `json:"setup,omitempty"`
	Providers []Provider `json:"providers"`
}

type Provider struct {
	Label string `json:"label"`
	URL   string `json:"url"`
	// Unavailable: its identity provider has not answered yet; the button
	// is shown disabled.
	Unavailable bool `json:"unavailable,omitempty"`
}

// publicAPI answers the routes that need no session; false for others.
func (s *Server) publicAPI(w http.ResponseWriter, r *http.Request, path string) bool {
	h := s.opts.Hosted
	switch path {
	case "/api/login-methods":
		if r.Method != http.MethodGet {
			s.fail(w, http.StatusMethodNotAllowed, "method not allowed")
			return true
		}
		m := LoginMethods{App: App, Local: h.Users != nil, Providers: []Provider{}}
		if h.Users != nil {
			m.Setup, _ = h.Users.Empty()
		}
		for _, a := range h.Auth {
			p := Provider{Label: a.Label(), URL: s.pub.base + a.Routes()[0]}
			if rd, ok := a.(Readier); ok {
				p.Unavailable = rd.Ready() != nil
			}
			m.Providers = append(m.Providers, p)
		}
		s.json(w, http.StatusOK, m)
		return true
	case "/api/login", "/api/login/code", "/api/setup", "/api/link", "/api/link/password":
	default:
		return false
	}
	body, ok := s.postBody(w, r)
	defer clear(body)
	if !ok {
		return true
	}
	if r.Header.Get(Header) == "" {
		s.fail(w, http.StatusForbidden, "missing "+Header+" header")
		return true
	}
	if h.Users == nil {
		s.fail(w, http.StatusNotFound, "there are no local user accounts here")
		return true
	}
	var req struct {
		Username string `json:"username"`
		Name     string `json:"name"`
		Password string `json:"password"`
		Code     string `json:"code"`
		Ticket   string `json:"ticket"`
	}
	if decode(body, &req) != nil {
		s.fail(w, http.StatusBadRequest, "malformed request")
		return true
	}
	ctx := r.Context()
	switch path {
	case "/api/login":
		u, err := h.Users.Login(ctx, req.Username, req.Password)
		if err != nil {
			if errors.Is(err, users.ErrInvalid) {
				if known, ok := h.Users.Find(req.Username); ok {
					s.printf("Failed login for %s.", printable(known.Username))
				}
			}
			s.userError(w, err)
			return true
		}
		if u.TOTP != "" {
			// The password was right; the session starts with the code.
			s.json(w, http.StatusOK, map[string]any{"app": App, "secondFactor": true, "ticket": s.newTicket(u.ID)})
			return true
		}
		s.loggedIn(w, r, u)
	case "/api/login/code":
		s.loginCode(w, r, req.Ticket, req.Code)
	case "/api/setup":
		if !s.useSetupCode(req.Code) {
			s.fail(w, http.StatusBadRequest, "this setup link is not valid (used already, expired, or from an earlier start); see the server's log")
			return true
		}
		u, err := h.Users.AddWithPassword(ctx, req.Username, req.Name, users.RoleAdmin, req.Password, false, true)
		if err != nil {
			if !errors.Is(err, users.ErrNotEmpty) {
				s.restoreSetupCode(req.Code)
			}
			s.userError(w, err)
			return true
		}
		s.printf("First admin %s created.", printable(u.Username))
		if rec, err := h.Users.RecordLogin(u.ID); err == nil {
			u = rec
		}
		s.loggedIn(w, r, u)
	case "/api/link":
		u, err := h.Users.LinkUser(req.Code)
		if err != nil {
			s.userError(w, err)
			return true
		}
		s.json(w, http.StatusOK, map[string]string{"app": App, "username": u.Username, "name": u.Name})
	case "/api/link/password":
		u, err := h.Users.UseLink(ctx, req.Code, req.Password)
		if err != nil {
			s.userError(w, err)
			return true
		}
		s.printf("Password set by link for %s.", printable(u.Username))
		if rec, err := h.Users.RecordLogin(u.ID); err == nil {
			u = rec
		}
		s.loggedIn(w, r, u)
	}
	return true
}

func decode(body []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

// loggedIn starts the session of a local user; the page reloads to get
// its key.
func (s *Server) loggedIn(w http.ResponseWriter, r *http.Request, u users.User) {
	if s.startSession(w, r, Identity{}, u) == nil {
		s.fail(w, http.StatusServiceUnavailable, errClosed.Error())
		return
	}
	s.json(w, http.StatusOK, map[string]any{"app": App, "mustChangePassword": u.MustChange})
}

// useSetupCode takes the one-time setup code, if it is the current one.
func (s *Server) useSetupCode(code string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if code == "" || s.setupHash == "" || !same(sessionID(code), s.setupHash) || !s.now().Before(s.setupUntil) {
		return false
	}
	s.setupHash = ""
	return true
}

// restoreSetupCode gives the code back after a refused form (a weak
// password, a bad name), so the link still works.
func (s *Server) restoreSetupCode(code string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.setupHash == "" {
		s.setupHash = sessionID(code)
	}
}

// userError answers an error of the users store.
func (s *Server) userError(w http.ResponseWriter, err error) {
	var wait *users.WaitError
	switch {
	case errors.As(err, &wait):
		w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(wait.Retry.Seconds()))))
		s.fail(w, http.StatusTooManyRequests, upper(err.Error()))
	case errors.Is(err, users.ErrInvalid):
		s.fail(w, http.StatusUnauthorized, "Wrong username or password.")
	case errors.Is(err, users.ErrBusy):
		s.fail(w, http.StatusServiceUnavailable, upper(err.Error()))
	case errors.Is(err, users.ErrNotFound):
		s.fail(w, http.StatusNotFound, upper(err.Error()))
	case errors.Is(err, users.ErrExists), errors.Is(err, users.ErrNotEmpty):
		s.fail(w, http.StatusConflict, upper(err.Error()))
	case errors.Is(err, users.ErrLink):
		s.fail(w, http.StatusGone, upper(err.Error()))
	case errors.Is(err, context.Canceled):
		s.fail(w, http.StatusServiceUnavailable, "cancelled")
	default:
		// Policy and validation messages; store failures (a broken file)
		// are the operator's to see.
		if users.IsInput(err) {
			s.fail(w, http.StatusBadRequest, upper(err.Error()))
			return
		}
		s.log.Error(fmt.Sprintf("Users: %v", err))
		s.fail(w, http.StatusInternalServerError, "the user accounts cannot be read or written; see the server's log")
	}
}

func upper(msg string) string {
	if msg == "" {
		return msg
	}
	return string(bytes.ToUpper([]byte(msg[:1]))) + msg[1:]
}

// changePassword: POST /api/password {current, password}, local users.
// The user's other sessions end; this one stays.
func (s *Server) changePassword(w http.ResponseWriter, r *http.Request, ss *session, body []byte) {
	if ss.userID == "" {
		s.fail(w, http.StatusNotFound, "only local accounts have a password here")
		return
	}
	var req struct {
		Current  string `json:"current"`
		Password string `json:"password"`
	}
	if decode(body, &req) != nil {
		s.fail(w, http.StatusBadRequest, "malformed request")
		return
	}
	u, err := s.opts.Hosted.Users.ChangePassword(r.Context(), ss.userID, req.Current, req.Password)
	if err != nil {
		s.userError(w, err)
		return
	}
	s.mu.Lock()
	ss.epoch, ss.mustChange = u.Epoch, false
	s.logf(ss, "Password changed; other sessions end.")
	st := s.statusLocked(ss)
	s.mu.Unlock()
	s.json(w, http.StatusOK, st)
}

// logoutOthers: POST /api/logout-others, local users.
func (s *Server) logoutOthers(w http.ResponseWriter, ss *session) {
	if ss.userID == "" {
		s.fail(w, http.StatusNotFound, "only for local accounts")
		return
	}
	u, err := s.opts.Hosted.Users.EndSessions(ss.userID)
	if err != nil {
		s.userError(w, err)
		return
	}
	s.mu.Lock()
	ss.epoch = u.Epoch
	s.logf(ss, "Other sessions ended.")
	st := s.statusLocked(ss)
	s.mu.Unlock()
	s.json(w, http.StatusOK, st)
}

// UserInfo is an account as the admin page sees it (no hash).
type UserInfo struct {
	ID         string     `json:"id"`
	Username   string     `json:"username"`
	Name       string     `json:"name,omitempty"`
	Role       string     `json:"role"`
	Disabled   bool       `json:"disabled,omitempty"`
	Pending    bool       `json:"pending,omitempty"` // no password yet
	MustChange bool       `json:"mustChangePassword,omitempty"`
	Locked     bool       `json:"locked,omitempty"` // inside the delay after failed logins
	TOTP       bool       `json:"totp,omitempty"`   // has a second factor
	Created    time.Time  `json:"created"`
	LastLogin  *time.Time `json:"lastLogin,omitempty"`
	You        bool       `json:"you,omitempty"`
}

// admin checks that the session may manage local users.
func (s *Server) admin(w http.ResponseWriter, ss *session) bool {
	switch {
	case s.opts.Hosted == nil || s.opts.Hosted.Users == nil:
		s.fail(w, http.StatusNotFound, "there are no local user accounts here")
	case !ss.user.Admin:
		s.fail(w, http.StatusForbidden, "only admins manage users")
	default:
		return true
	}
	return false
}

// listUsers: GET /api/users, admins.
func (s *Server) listUsers(w http.ResponseWriter, ss *session) {
	if !s.admin(w, ss) {
		return
	}
	store := s.opts.Hosted.Users
	all, err := store.Users()
	if err != nil {
		s.userError(w, err)
		return
	}
	out := make([]UserInfo, 0, len(all))
	for _, u := range all {
		out = append(out, UserInfo{
			ID: u.ID, Username: u.Username, Name: u.Name, Role: u.Role, Disabled: u.Disabled, Pending: u.Hash == "",
			MustChange: u.MustChange, Locked: store.Locked(u.Username), TOTP: u.TOTP != "", Created: u.Created, LastLogin: u.LastLogin, You: u.ID == ss.userID,
		})
	}
	s.json(w, http.StatusOK, map[string]any{"app": App, "users": out})
}

// changeUser: POST /api/users/<action>, admins. Actions on the admin's own
// account (but adding) are refused: another admin does those.
func (s *Server) changeUser(w http.ResponseWriter, r *http.Request, ss *session, action string, body []byte) {
	if !s.admin(w, ss) {
		return
	}
	store := s.opts.Hosted.Users
	var req struct {
		ID       string `json:"id"`
		Username string `json:"username"`
		Name     string `json:"name"`
		Role     string `json:"role"`
	}
	if decode(body, &req) != nil {
		s.fail(w, http.StatusBadRequest, "malformed request")
		return
	}
	if action != "add" && req.ID == ss.userID {
		s.fail(w, http.StatusBadRequest, "not on your own account; another admin can do that")
		return
	}
	target, found := store.Get(req.ID)
	if action != "add" && !found {
		s.fail(w, http.StatusNotFound, "no such user")
		return
	}
	var err error
	answer := map[string]any{"app": App}
	switch action {
	case "add":
		var u users.User
		var code string
		if u, code, err = store.Add(req.Username, req.Name, req.Role); err == nil {
			answer["link"] = s.pub.LinkURL(code)
			answer["id"] = u.ID
			target = u
		}
	case "reset":
		var code string
		if code, err = store.Reset(req.ID); err == nil {
			answer["link"] = s.pub.LinkURL(code)
		}
	case "disable", "enable":
		_, err = store.SetDisabled(req.ID, action == "disable")
	case "role":
		_, err = store.SetRole(req.ID, req.Role)
	case "reset-totp":
		_, err = store.ResetTOTP(req.ID)
	case "delete":
		if err = store.Delete(req.ID); err == nil {
			s.removeHistory(req.ID)
		}
	default:
		s.fail(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		s.userError(w, err)
		return
	}
	if action == "role" || action == "add" {
		action += " " + printable(req.Role)
	}
	s.logf(ss, "User %s: %s.", printable(target.Username), action)
	s.json(w, http.StatusOK, answer)
}
