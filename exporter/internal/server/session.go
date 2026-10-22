package server

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode"

	"github.com/K4ugummi/ionos-explorer/exporter/internal/users"
)

// session is what the server holds for one logged-in browser: in local mode
// the one session the printed link opens, in hosted mode one per login.
// Guarded by Server.mu.
type session struct {
	// id is the hex SHA-256 of the cookie value: the map key, and its start
	// names the session in log lines. The cookie value itself is not kept.
	id   string
	key  string // sent by the page in Header
	user Identity
	// The Authenticator the user logged in with (nil: local users, local
	// mode).
	auth Authenticator
	// Local users: the account and its session epoch at login; the
	// session ends when the account is gone, disabled or its epoch moved.
	userID     string
	epoch      int
	mustChange bool
	// Second factor: set up; must be set up first ("required"); a secret
	// being set up, until when.
	totp, mustEnroll bool
	pendingTOTP      []byte
	pendingUntil     time.Time
	// Hosted mode: login time and last request, for the TTLs.
	created, seen time.Time

	token    []byte
	keep     bool
	lastUse  time.Time
	timer    *time.Timer
	job      *job
	result   []byte
	resultAt time.Time
	gone     bool // dropped; a fetch still running discards its result
}

func sessionID(cookie string) string {
	sum := sha256.Sum256([]byte(cookie))
	return hex.EncodeToString(sum[:])
}

// newSession creates a session and returns it with its cookie value. Holds s.mu.
func (s *Server) newSession(user Identity) (*session, string) {
	cookie := random()
	now := s.now()
	ss := &session{id: sessionID(cookie), key: random(), user: user, created: now, seen: now}
	s.sessions[ss.id] = ss
	return ss, cookie
}

// session finds the session of a request by its cookie, nil without one or
// when it expired. Each request counts as activity.
func (s *Server) session(r *http.Request) *session {
	c, err := r.Cookie(s.cookieName)
	if err != nil || c.Value == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ss := s.sessions[sessionID(c.Value)]
	if ss == nil {
		return nil
	}
	now := s.now()
	if s.expired(ss, now) {
		s.drop(ss, "Session expired.")
		return nil
	}
	if ss.userID != "" && !s.current(ss) {
		return nil
	}
	ss.seen = now
	return ss
}

// current brings a local user's session up to date with the account (name,
// role, must change the password) or ends it. Holds s.mu.
func (s *Server) current(ss *session) bool {
	u, ok := s.opts.Hosted.Users.Get(ss.userID)
	switch {
	case !ok:
		s.drop(ss, "Session ended: the account was deleted.")
		return false
	case u.Disabled:
		s.drop(ss, "Session ended: the account was disabled.")
		return false
	case u.Epoch != ss.epoch:
		s.drop(ss, "Session ended: password changed or sessions ended.")
		return false
	}
	ss.user.Name, ss.user.Admin, ss.mustChange = u.Display(), u.Role == users.RoleAdmin, u.MustChange
	ss.totp, ss.mustEnroll = u.TOTP != "", s.opts.Hosted.TOTP == TOTPRequired && u.TOTP == ""
	return true
}

// expired reports whether a hosted session is past its lifetime or idle
// time. Local sessions last as long as the program. Holds s.mu.
func (s *Server) expired(ss *session, now time.Time) bool {
	h := s.opts.Hosted
	return h != nil && (!now.Before(ss.created.Add(h.SessionTTL)) || !now.Before(ss.seen.Add(h.SessionIdle)))
}

// drop ends a session: fetch cancelled, token zeroed, result dropped.
// Holds s.mu.
func (s *Server) drop(ss *session, why string) {
	if ss.gone {
		return
	}
	s.release(ss)
	ss.gone = true
	delete(s.sessions, ss.id)
	s.logf(ss, "%s", why)
}

// release cancels the session's fetch and drops its token and result.
// Holds s.mu.
func (s *Server) release(ss *session) {
	if ss.job != nil && ss.job.State == stateRunning {
		ss.job.cancel()
	}
	s.dropToken(ss)
	clear(ss.result)
	ss.result = nil
	clear(ss.pendingTOTP)
	ss.pendingTOTP = nil
}

// sweep ends expired sessions, drops results nobody took and renews an
// expired setup link.
func (s *Server) sweep() {
	h := s.opts.Hosted
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if s.setupHash != "" && !now.Before(s.setupUntil) {
		s.newSetupLink()
	}
	s.dropTickets(now)
	for _, ss := range s.sessions {
		switch {
		case s.expired(ss, now):
			s.drop(ss, "Session expired.")
		case ss.userID != "" && !s.current(ss):
		case ss.result != nil && !now.Before(ss.resultAt.Add(h.ResultTTL)):
			clear(ss.result)
			ss.result = nil
			s.logf(ss, "Fetched snapshot not taken within %s; dropped.", h.ResultTTL)
		}
	}
}

// janitor sweeps until the server closes, and applies the history's
// retention at the start and then hourly.
func (s *Server) janitor(every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	s.prune()
	pruned := time.Now()
	for {
		select {
		case <-s.stop:
			return
		case <-t.C:
			s.sweep()
			if time.Since(pruned) >= pruneEvery {
				s.prune()
				pruned = time.Now()
			}
		}
	}
}

// login starts a hosted session for a user a logged in (its LoginFunc) and
// sends the browser on to the explorer.
func (s *Server) login(w http.ResponseWriter, r *http.Request, a Authenticator, id Identity) {
	ss := s.startSession(w, r, id, users.User{})
	if ss == nil {
		http.Error(w, errClosed.Error(), http.StatusServiceUnavailable)
		return
	}
	s.mu.Lock()
	ss.auth = a
	s.mu.Unlock()
	http.Redirect(w, r, s.pub.base+"/", http.StatusSeeOther)
}

// startSession starts a hosted session and sets its cookie: a new one every
// time, and the session the browser had before, if any, ends. For a local
// user, u is the account. Nil once the server is closed.
func (s *Server) startSession(w http.ResponseWriter, r *http.Request, id Identity, u users.User) *session {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	if c, err := r.Cookie(s.cookieName); err == nil {
		if old := s.sessions[sessionID(c.Value)]; old != nil {
			s.drop(old, "Session replaced by a new login.")
		}
	}
	if u.ID != "" {
		id = Identity{Subject: "local:" + u.ID, Name: u.Display(), Admin: u.Role == users.RoleAdmin}
	}
	ss, cookie := s.newSession(id)
	ss.userID, ss.epoch, ss.mustChange = u.ID, u.Epoch, u.MustChange
	if u.ID != "" {
		ss.totp, ss.mustEnroll = u.TOTP != "", s.opts.Hosted.TOTP == TOTPRequired && u.TOTP == ""
	}
	s.logf(ss, "Logged in.")
	http.SetCookie(w, s.cookie(cookie))
	return ss
}

// newSetupLink makes and logs the one-time link that creates the first
// admin. Holds s.mu.
func (s *Server) newSetupLink() {
	code := random()
	s.setupHash, s.setupUntil = sessionID(code), s.now().Add(setupTTL)
	s.log.Link(fmt.Sprintf("No user accounts yet. To create the first admin, open this link within %s (once; a restart or the expiry makes a new one)", setupTTL),
		s.pub.String()+"/#setup="+code)
}

// setupTTL is how long the link that creates the first admin is valid.
const setupTTL = time.Hour

// cookie is the session cookie with this value. Hosted: __Host- (or
// __Secure- under a sub-path, where Path cannot be /) and Secure over https;
// Lax, so the cookie survives the redirect back from an identity provider.
func (s *Server) cookie(value string) *http.Cookie {
	c := &http.Cookie{Name: s.cookieName, Value: value, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode}
	if s.opts.Hosted != nil {
		c.SameSite = http.SameSiteLaxMode
		c.Secure = s.pub.secure
		if s.pub.base != "" {
			c.Path = s.pub.base
		}
	}
	return c
}

// logf writes a log line, in hosted mode naming the session and its user.
func (s *Server) logf(ss *session, format string, a ...any) {
	if s.opts.Hosted == nil || ss == nil {
		s.printf(format, a...)
		return
	}
	s.log.Session(ss.id[:8], ss.user.Subject, fmt.Sprintf(format, a...))
}

// printable keeps what a user name may contain from breaking a log line.
func printable(v string) string {
	v = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			return '_'
		}
		return r
	}, v)
	if r := []rune(v); len(r) > 80 {
		v = string(r[:80]) + "…"
	}
	return v
}
