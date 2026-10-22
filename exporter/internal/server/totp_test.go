package server

import (
	"encoding/base32"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"filippo.io/age"

	"github.com/K4ugummi/ionos-explorer/exporter/internal/users"
)

// startTOTP starts a hosted server with local users that have a key for
// second factors, in the given mode.
func startTOTP(t *testing.T, clk *clock, mode string) (*harness, *users.Store) {
	t.Helper()
	id, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	store, err := users.Open(t.TempDir(), users.Options{
		Params: users.Params{Memory: 64, Time: 1, Threads: 1}, Now: clk.now, Identities: []*age.X25519Identity{id},
	})
	if err != nil {
		t.Fatal(err)
	}
	h := startHosted(t, "https://explorer.example", func(o *Options) {
		o.Hosted.Auth, o.Hosted.Users, o.Hosted.TOTP = nil, store, mode
		o.now = clk.now
	})
	return h, store
}

// enrol sets up a second factor for the logged-in client; it answers the
// secret and the recovery codes.
func (h *harness) enrol(clk *clock) ([]byte, []string) {
	h.t.Helper()
	code, body := h.post("/api/totp/begin", "{}")
	var begun struct{ Key, URI string }
	if code != http.StatusOK || json.Unmarshal([]byte(body), &begun) != nil || !strings.HasPrefix(begun.URI, "otpauth://totp/") {
		h.t.Fatalf("begin: %d %s", code, body)
	}
	secret, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(begun.Key)
	if err != nil {
		h.t.Fatal(err)
	}
	code, body = h.post("/api/totp/enable", `{"password":"`+password+`","code":"`+users.TOTP(secret, clk.now())+`"}`)
	var enabled struct {
		RecoveryCodes []string `json:"recoveryCodes"`
		Status        Status   `json:"status"`
	}
	if code != http.StatusOK || json.Unmarshal([]byte(body), &enabled) != nil || len(enabled.RecoveryCodes) != 10 || !enabled.Status.TOTP {
		h.t.Fatalf("enable: %d %s", code, body)
	}
	return secret, enabled.RecoveryCodes
}

// codeLogin logs in with a password and a code; it answers the status of
// the second step.
func (h *harness) codeLogin(user, code string) int {
	h.t.Helper()
	resp, b := h.public("/api/login", `{"username":"`+user+`","password":"`+password+`"}`)
	var first struct {
		SecondFactor bool   `json:"secondFactor"`
		Ticket       string `json:"ticket"`
	}
	if resp.StatusCode != http.StatusOK || json.Unmarshal([]byte(b), &first) != nil || !first.SecondFactor || first.Ticket == "" || len(resp.Cookies()) > 0 {
		h.t.Fatalf("first step: %d %s %v", resp.StatusCode, b, resp.Cookies())
	}
	resp, b = h.public("/api/login/code", `{"ticket":"`+first.Ticket+`","code":"`+code+`"}`)
	if resp.StatusCode == http.StatusOK {
		h.cookie = resp.Cookies()[0]
		h.readKey()
	}
	return resp.StatusCode
}

func TestTOTPLogin(t *testing.T) {
	clk := &clock{t: time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)}
	h, store := startTOTP(t, clk, TOTPOptional)
	addUser(t, store, "alice", users.RoleUser, false)
	h.passwordLogin("alice", password)
	other := h.client()
	other.passwordLogin("alice", password)
	if st := h.status(); st.TOTP || !st.TOTPAvailable || st.MustEnrollTOTP {
		t.Fatalf("%+v", st)
	}

	// Enabling needs the password and a right code, then ends the other sessions.
	h.post("/api/totp/begin", "{}")
	if code, body := h.post("/api/totp/enable", `{"password":"wrong password","code":"123456"}`); code != http.StatusBadRequest || !strings.Contains(body, "current password") {
		t.Errorf("wrong password: %d %s", code, body)
	}
	if code, body := h.post("/api/totp/enable", `{"password":"`+password+`","code":"000000"}`); code != http.StatusBadRequest || !strings.Contains(body, "not right") {
		t.Errorf("wrong code: %d %s", code, body)
	}
	secret, recovery := h.enrol(clk)
	if code := other.code(req{path: "/api/status"}); code != http.StatusUnauthorized {
		t.Errorf("other session after enabling: %d", code)
	}
	if !h.status().TOTP {
		t.Error("this session keeps going")
	}
	if code, _ := h.post("/api/totp/begin", "{}"); code != http.StatusConflict {
		t.Errorf("begin again: %d", code)
	}
	for _, s := range append(recovery, base32.StdEncoding.EncodeToString(secret)) {
		if strings.Contains(h.log.String(), s) {
			t.Fatal("a secret is in the log")
		}
	}

	// The password alone gives no session; the code does, once.
	c := h.client()
	clk.add(time.Minute)
	now := users.TOTP(secret, clk.now())
	if code := c.codeLogin("alice", "000000"); code != http.StatusUnauthorized {
		t.Errorf("wrong code: %d", code)
	}
	if code := c.codeLogin("alice", now); code != http.StatusOK || c.status().User != "alice" {
		t.Fatalf("right code: %d", code)
	}
	if code := h.client().codeLogin("alice", now); code != http.StatusUnauthorized {
		t.Errorf("the same code again: %d", code)
	}
	// A recovery code works once.
	if code := h.client().codeLogin("alice", recovery[0]); code != http.StatusOK {
		t.Errorf("recovery code: %d", code)
	}
	if code := h.client().codeLogin("alice", recovery[0]); code != http.StatusUnauthorized {
		t.Errorf("recovery code again: %d", code)
	}

	// A ticket: once, 5 tries, 5 minutes, and nothing else.
	resp, b := h.public("/api/login", `{"username":"alice","password":"`+password+`"}`)
	var first struct{ Ticket string }
	_ = json.Unmarshal([]byte(b), &first)
	for i := range 5 {
		if resp, _ := h.public("/api/login/code", `{"ticket":"`+first.Ticket+`","code":"999999"}`); resp.StatusCode != http.StatusUnauthorized && !(i == 4 && resp.StatusCode == http.StatusTooManyRequests) {
			t.Fatalf("try %d: %d", i, resp.StatusCode)
		}
	}
	clk.add(time.Hour) // past the delays the wrong codes earned
	if resp, _ := h.public("/api/login/code", `{"ticket":"`+first.Ticket+`","code":"`+users.TOTP(secret, clk.now())+`"}`); resp.StatusCode != http.StatusGone {
		t.Errorf("ticket after 5 tries: %d", resp.StatusCode)
	}
	resp, b = h.public("/api/login", `{"username":"alice","password":"`+password+`"}`)
	_ = json.Unmarshal([]byte(b), &first)
	clk.add(ticketTTL)
	if resp, _ := h.public("/api/login/code", `{"ticket":"`+first.Ticket+`","code":"`+users.TOTP(secret, clk.now())+`"}`); resp.StatusCode != http.StatusGone {
		t.Errorf("expired ticket: %d", resp.StatusCode)
	}
	for _, ticket := range []string{"", "made-up"} {
		if resp, _ := h.public("/api/login/code", `{"ticket":"`+ticket+`","code":"123456"}`); resp.StatusCode != http.StatusGone {
			t.Errorf("ticket %q: %d", ticket, resp.StatusCode)
		}
	}
	_ = resp

	// New recovery codes, then off again (password needed).
	if code, body := h.post("/api/totp/recovery", `{"password":"`+password+`"}`); code != http.StatusOK || strings.Count(body, "-") < 10 {
		t.Errorf("recovery: %d %s", code, body)
	}
	if code, _ := h.post("/api/totp/disable", `{"password":"wrong password"}`); code != http.StatusBadRequest {
		t.Errorf("disable, wrong password: %d", code)
	}
	clk.add(time.Hour)
	if code, body := h.post("/api/totp/disable", `{"password":"`+password+`"}`); code != http.StatusOK || strings.Contains(body, `"totp":true`) {
		t.Fatalf("disable: %d %s", code, body)
	}
	h.client().passwordLogin("alice", password) // one step again
}

func TestTOTPRequired(t *testing.T) {
	clk := &clock{t: time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)}
	h, store := startTOTP(t, clk, TOTPRequired)
	addUser(t, store, "root", users.RoleAdmin, false)
	bob := addUser(t, store, "bob", users.RoleUser, false)
	h.passwordLogin("bob", password)
	if st := h.status(); !st.MustEnrollTOTP {
		t.Fatalf("%+v", st)
	}
	for _, r := range []req{
		{method: http.MethodPost, path: "/api/fetch", body: `{"token":"x","keep":false}`},
		{path: "/api/users"},
		{method: http.MethodPost, path: "/api/totp/disable", body: `{"password":"` + password + `"}`},
	} {
		if resp, b := h.do(r); resp.StatusCode != http.StatusForbidden || !strings.Contains(string(b), "two-factor") {
			t.Errorf("%s %s before enrolling: %d %s", r.method, r.path, resp.StatusCode, b)
		}
	}
	h.enrol(clk)
	if st := h.status(); st.MustEnrollTOTP || !st.TOTP {
		t.Fatalf("%+v", st)
	}
	if code, body := h.post("/api/totp/disable", `{"password":"`+password+`"}`); code != http.StatusForbidden {
		t.Errorf("disable where required: %d %s", code, body)
	}

	// An admin resets bob's second factor (a lost phone): his sessions end,
	// and he sets one up again at the next login.
	admin := h.client()
	admin.passwordLogin("root", password)
	admin.enrol(clk)
	if code, body := admin.post("/api/users/reset-totp", `{"id":"`+bob.ID+`"}`); code != http.StatusOK {
		t.Fatal(code, body)
	}
	if code := h.code(req{path: "/api/status"}); code != http.StatusUnauthorized {
		t.Errorf("bob's session after the reset: %d", code)
	}
	h.passwordLogin("bob", password)
	if !h.status().MustEnrollTOTP {
		t.Error("bob must set it up again")
	}
	var list struct{ Users []UserInfo }
	_, b := admin.do(req{path: "/api/users"})
	_ = json.Unmarshal(b, &list)
	for _, u := range list.Users {
		if (u.Username == "root") != u.TOTP {
			t.Errorf("%s: totp %v", u.Username, u.TOTP)
		}
	}
}

func TestTOTPModes(t *testing.T) {
	clk := &clock{t: time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)}
	h, store := startTOTP(t, clk, TOTPOff)
	addUser(t, store, "alice", users.RoleUser, false)
	h.passwordLogin("alice", password)
	if st := h.status(); st.TOTPAvailable {
		t.Error("offered when off")
	}
	if code, _ := h.post("/api/totp/begin", "{}"); code != http.StatusNotFound {
		t.Errorf("begin when off: %d", code)
	}

	// Without a key: not offered, and "required" refuses to start.
	plain, plainStore := startLocal(t, nil, nil)
	addUser(t, plainStore, "bob", users.RoleUser, false)
	plain.passwordLogin("bob", password)
	if st := plain.status(); st.TOTPAvailable {
		t.Error("offered without a key")
	}
	for mode, ok := range map[string]bool{TOTPRequired: false, "sometimes": false, TOTPOptional: true, "": true} {
		_, err := New(Options{Hosted: &Hosted{PublicURL: "https://explorer.example", Users: plainStore, TOTP: mode}, UI: ui})
		if (err == nil) != ok {
			t.Errorf("mode %q without key: %v", mode, err)
		}
	}
}
