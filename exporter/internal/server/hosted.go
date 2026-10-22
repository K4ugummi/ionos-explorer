package server

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/K4ugummi/ionos-explorer/exporter/internal/history"
	"github.com/K4ugummi/ionos-explorer/exporter/internal/users"
)

// Hosted runs the server for a team: on any address, behind a proxy that
// terminates TLS, with a session per logged-in user. See
// docs/ARCHITECTURE.md, "Hosted mode".
type Hosted struct {
	// PublicURL is the address users open (https://explorer.example.com or
	// https://tools.example.com/ionos-explorer). It decides the Host and
	// Origin checks, the base path and the cookie; X-Forwarded-* headers are
	// never trusted. http:// only for localhost (trials).
	PublicURL string
	// Users are the local user accounts (nil: none), Auth the other login
	// methods (OIDC providers), one button each. At least one of them: there
	// is no hosted mode without login.
	Users *users.Store
	Auth  []Authenticator
	// MaxFetches limits the fetches running at once over all sessions
	// (default 2).
	MaxFetches int
	// SessionTTL ends a session that long after login (default 12h),
	// SessionIdle that long after its last request (default 2h).
	SessionTTL, SessionIdle time.Duration
	// ResultTTL drops a fetched snapshot nobody took (default 10m).
	ResultTTL time.Duration
	// History keeps every fetched snapshot, per user (nil: none).
	History *history.Store
	// TOTP is the second factor of local users: "off" (not offered; ones
	// set up before are still asked for), "optional" (the default; offered
	// when Users has a key) or "required" (every local user sets one up at
	// the next login; needs the key).
	TOTP string
}

// Identity is a logged-in user.
type Identity struct {
	// Subject is unique and stable: "local:<id>" or "oidc:<provider>:<sub>".
	// Log lines name it.
	Subject string
	// Name is shown in the page.
	Name  string
	Admin bool
	// LogoutHint is what the Authenticator needs to end the login at its
	// identity provider too (an OIDC ID token); kept in the session only,
	// never logged or sent to the page.
	LogoutHint string
}

// LoginFunc starts a session for a user the Authenticator has logged in
// and answers the request (cookie, then on to the explorer).
type LoginFunc func(w http.ResponseWriter, r *http.Request, id Identity)

// Authenticator serves login routes of hosted mode to browsers without a
// session (OIDC providers; local users are built in).
type Authenticator interface {
	// Label is the text of its button on the login screen.
	Label() string
	// Routes are paths below the base path it serves ("/login/kc",
	// "/callback/" for everything below). The button leads to the first.
	Routes() []string
	// ServeLogin answers a request for one of its routes; path is the
	// request path below the base path. A login ends with done.
	ServeLogin(w http.ResponseWriter, r *http.Request, path string, done LoginFunc)
}

// Logouter is an Authenticator that also ends the login at its identity
// provider: LogoutURL is where the browser goes after the session ended
// ("" for nowhere), and the provider sends it back to back.
type Logouter interface {
	LogoutURL(id Identity, back string) string
}

// publicURL is a checked Hosted.PublicURL.
type publicURL struct {
	origin string // scheme://host[:port], lower case, no default port
	host   string // what the Host header must say
	base   string // path prefix without the trailing slash, "" at the root
	secure bool   // https
}

// String is the public URL without a trailing slash.
func (p publicURL) String() string { return p.origin + p.base }

// LinkURL is the address of a one-time link to set a password. The code is
// in the fragment: it reaches no server log and no Referer.
func (p publicURL) LinkURL(code string) string { return p.String() + "/#link=" + code }

var basePath = regexp.MustCompile(`^(/[A-Za-z0-9._~-]+)*$`)

// ParsePublicURL checks a public URL for hosted mode.
func ParsePublicURL(raw string) (publicURL, error) {
	var p publicURL
	if raw == "" {
		return p, errors.New("hosted mode needs the public URL, the address users open (https://explorer.example.com)")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Opaque != "" || u.Host == "" {
		return p, fmt.Errorf("public URL %q: not an absolute URL", raw)
	}
	if u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return p, fmt.Errorf("public URL %q: no user, query or fragment", raw)
	}
	host := strings.ToLower(u.Hostname())
	switch u.Scheme {
	case "https":
		p.secure = true
	case "http":
		if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			return p, fmt.Errorf("public URL %q: https is required (http only for localhost, to try it out)", raw)
		}
	default:
		return p, fmt.Errorf("public URL %q: https is required", raw)
	}
	p.host = host
	if strings.Contains(host, ":") {
		p.host = "[" + host + "]"
	}
	if port := u.Port(); port != "" && !(port == "443" && p.secure || port == "80" && !p.secure) {
		p.host += ":" + port
	}
	p.origin = u.Scheme + "://" + p.host
	p.base = strings.TrimSuffix(u.Path, "/")
	if u.RawPath != "" || !basePath.MatchString(p.base) || strings.Contains(p.base+"/", "/./") || strings.Contains(p.base+"/", "/../") {
		return p, fmt.Errorf("public URL %q: the path may only hold letters, digits and . _ ~ -", raw)
	}
	return p, nil
}

func (h *Hosted) check() error {
	if h.Users == nil && len(h.Auth) == 0 {
		return errors.New("hosted mode needs a login method: local users or an OIDC provider")
	}
	var routes []string
	for _, a := range h.Auth {
		if a == nil || len(a.Routes()) == 0 {
			return errors.New("a login method without routes")
		}
		for _, r := range a.Routes() {
			if !strings.HasPrefix(r, "/") || r == "/" || r == "/index.html" || r == "/api" || strings.HasPrefix(r, "/api/") || strings.HasPrefix(r, "/assets/") {
				return fmt.Errorf("login route %q: not a path of its own", r)
			}
			for _, o := range routes {
				if overlap(r, o) {
					return fmt.Errorf("login routes %q and %q overlap", o, r)
				}
			}
			routes = append(routes, r)
		}
	}
	switch h.TOTP {
	case "":
		h.TOTP = TOTPOptional
	case TOTPOff, TOTPOptional:
	case TOTPRequired:
		if h.Users == nil || !h.Users.CanSeal() {
			return errors.New("two-factor authentication \"required\" needs local users and the age identity (IONOS_EXPLORER_AGE_IDENTITY_FILE) that keeps the secrets")
		}
	default:
		return fmt.Errorf("two-factor authentication %q: off, optional or required", h.TOTP)
	}
	if h.MaxFetches < 0 || h.SessionTTL < 0 || h.SessionIdle < 0 || h.ResultTTL < 0 {
		return errors.New("hosted limits must not be negative")
	}
	if h.MaxFetches == 0 {
		h.MaxFetches = 2
	}
	if h.SessionTTL == 0 {
		h.SessionTTL = 12 * time.Hour
	}
	if h.SessionIdle == 0 {
		h.SessionIdle = 2 * time.Hour
	}
	if h.ResultTTL == 0 {
		h.ResultTTL = 10 * time.Minute
	}
	return nil
}

// loginRoute finds the Authenticator that serves path (below the base
// path), nil if none does.
func (h *Hosted) loginRoute(path string) Authenticator {
	for _, a := range h.Auth {
		for _, r := range a.Routes() {
			if matches(r, path) {
				return a
			}
		}
	}
	return nil
}

// matches reports whether a login route serves path: the same, or below a
// route that ends in /.
func matches(route, path string) bool {
	return path == route || strings.HasSuffix(route, "/") && strings.HasPrefix(path, route)
}

// overlap reports whether two login routes could serve the same path.
func overlap(a, b string) bool { return matches(a, b) || matches(b, a) }
