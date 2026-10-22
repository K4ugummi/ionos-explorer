package server

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/K4ugummi/ionos-explorer/exporter/internal/users"
)

const password = "correct horse battery"

// startLocal starts a hosted server with local users in a temp DATA_DIR.
func startLocal(t *testing.T, clk *clock, mod func(*Options, *users.Store)) (*harness, *users.Store) {
	t.Helper()
	uo := users.Options{Params: users.Params{Memory: 64, Time: 1, Threads: 1}}
	if clk != nil {
		uo.Now = clk.now
	}
	store, err := users.Open(t.TempDir(), uo)
	if err != nil {
		t.Fatal(err)
	}
	h := startHosted(t, "https://explorer.example", func(o *Options) {
		o.Hosted.Auth, o.Hosted.Users = nil, store
		if clk != nil {
			o.now = clk.now
		}
		if mod != nil {
			mod(o, store)
		}
	})
	return h, store
}

func addUser(t *testing.T, store *users.Store, name, role string, mustChange bool) users.User {
	t.Helper()
	u, err := store.AddWithPassword(context.Background(), name, "", role, password, mustChange, false)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

// public posts to a route that needs no session.
func (h *harness) public(path, body string) (*http.Response, string) {
	h.t.Helper()
	resp, b := h.do(req{method: http.MethodPost, path: path, body: body, header: map[string]string{Header: "login"}, noKey: true})
	return resp, string(b)
}

// passwordLogin logs this client in and reads the key from the page.
func (h *harness) passwordLogin(user, pw string) map[string]any {
	h.t.Helper()
	resp, b := h.public("/api/login", `{"username":"`+user+`","password":"`+pw+`"}`)
	if resp.StatusCode != http.StatusOK || len(resp.Cookies()) != 1 {
		h.t.Fatalf("login %s: %d %s", user, resp.StatusCode, b)
	}
	h.cookie = resp.Cookies()[0]
	h.readKey()
	var out map[string]any
	_ = json.Unmarshal([]byte(b), &out)
	return out
}

func (h *harness) readKey() {
	h.t.Helper()
	_, b := h.do(req{path: "/"})
	m := sessionKeyMeta.FindSubmatch(b)
	if m == nil {
		h.t.Fatalf("no key in the page: %s", b)
	}
	h.key = string(m[1])
}

func (h *harness) code(r req) int {
	h.t.Helper()
	resp, _ := h.do(r)
	return resp.StatusCode
}

func TestLoginMethods(t *testing.T) {
	h, store := startLocal(t, nil, nil)
	resp, b := h.do(req{path: "/api/login-methods", noKey: true})
	var m LoginMethods
	if resp.StatusCode != http.StatusOK || json.Unmarshal(b, &m) != nil || !m.Local || !m.Setup || len(m.Providers) != 0 {
		t.Errorf("%d %s", resp.StatusCode, b)
	}
	addUser(t, store, "alice", users.RoleAdmin, false)
	_, b = h.do(req{path: "/api/login-methods", noKey: true})
	if strings.Contains(string(b), `"setup":`) {
		t.Errorf("setup still offered: %s", b)
	}
	if code := h.code(req{method: http.MethodPost, path: "/api/login-methods", body: "{}"}); code != http.StatusMethodNotAllowed {
		t.Error(code)
	}

	// Another method only: its button, no password form.
	o := startHosted(t, "https://explorer.example", nil)
	_, b = o.do(req{path: "/api/login-methods", noKey: true})
	if string(b) != `{"app":"ionos-explorer","local":false,"providers":[{"label":"Test login","url":"/login"}]}`+"\n" {
		t.Errorf("%s", b)
	}
	if resp, b := o.public("/api/login", `{"username":"a","password":"b"}`); resp.StatusCode != http.StatusNotFound {
		t.Errorf("password login without local users: %d %s", resp.StatusCode, b)
	}
	// A provider whose identity provider has not answered: shown disabled.
	o = startHosted(t, "https://explorer.example", func(o *Options) { o.Hosted.Auth = []Authenticator{unready{}, other{}} })
	_, b = o.do(req{path: "/api/login-methods", noKey: true})
	if !strings.Contains(string(b), `[{"label":"Test login","url":"/login","unavailable":true},{"label":"Other","url":"/login/other"}]`) {
		t.Errorf("%s", b)
	}
}

var setupLink = regexp.MustCompile(`https://explorer\.example/#setup=([A-Za-z0-9_-]{43})`)

func TestSetup(t *testing.T) {
	clk := &clock{t: time.Date(2026, 10, 16, 8, 0, 0, 0, time.UTC)}
	h, store := startLocal(t, clk, nil)
	m := setupLink.FindStringSubmatch(h.log.String())
	if m == nil {
		t.Fatalf("no setup link logged: %s", h.log)
	}
	code := m[1]
	for _, c := range []struct {
		body string
		want int
	}{ // in this order
		{`{"code":"nope","username":"root","password":"` + password + `"}`, 400},
		{`{"code":"` + code + `","username":"root","password":"short"}`, 400}, // the code still works after this
		{`{"code":"` + code + `","username":"r o o t","password":"` + password + `"}`, 400},
		{`{"code":"` + code + `","username":"root","name":"Root","password":"` + password + `"}`, 200},
		{`{"code":"` + code + `","username":"root2","password":"` + password + `"}`, 400}, // once
	} {
		body, want := c.body, c.want
		if resp, b := h.public("/api/setup", body); resp.StatusCode != want {
			t.Errorf("%s: %d %s", body, resp.StatusCode, b)
		} else if want == 200 {
			h.cookie = resp.Cookies()[0]
		}
	}
	h.readKey()
	if st := h.status(); st.User != "Root" || !st.Admin || !st.LocalUser || st.MustChangePassword {
		t.Errorf("%+v", st)
	}
	if all, _ := store.Users(); len(all) != 1 || all[0].Role != users.RoleAdmin || all[0].LastLogin == nil {
		t.Errorf("%+v", all)
	}
	// With users, no new setup link, even after the expiry.
	clk.add(2 * time.Hour)
	h.s.sweep()
	if n := len(setupLink.FindAllString(h.log.String(), -1)); n != 1 {
		t.Errorf("%d setup links logged", n)
	}

	// Expired: a new link is logged, the old one refused.
	e, _ := startLocal(t, clk, nil)
	old := setupLink.FindStringSubmatch(e.log.String())[1]
	clk.add(time.Hour)
	e.s.sweep()
	links := setupLink.FindAllStringSubmatch(e.log.String(), -1)
	if len(links) != 2 || links[1][1] == old {
		t.Fatalf("no new link: %s", e.log)
	}
	if resp, _ := e.public("/api/setup", `{"code":"`+old+`","username":"root","password":"`+password+`"}`); resp.StatusCode != http.StatusBadRequest {
		t.Error("expired setup link used")
	}
	if resp, _ := e.public("/api/setup", `{"code":"`+links[1][1]+`","username":"root","password":"`+password+`"}`); resp.StatusCode != http.StatusOK {
		t.Error("new setup link refused")
	}
}

func TestPasswordLogin(t *testing.T) {
	clk := &clock{t: time.Date(2026, 10, 16, 8, 0, 0, 0, time.UTC)}
	h, store := startLocal(t, clk, nil)
	addUser(t, store, "alice", users.RoleAdmin, false)
	pending, _, _ := store.Add("pending", "", users.RoleUser)
	for name, body := range map[string]string{
		"wrong password": `{"username":"alice","password":"wrong"}`,
		"unknown user":   `{"username":"nobody","password":"` + password + `"}`,
		"no password":    `{"username":"` + pending.Username + `","password":""}`,
	} {
		resp, b := h.public("/api/login", body)
		if resp.StatusCode != http.StatusUnauthorized || !strings.Contains(b, `"Wrong username or password."`) || len(resp.Cookies()) > 0 {
			t.Errorf("%s: %d %s", name, resp.StatusCode, b)
		}
	}
	if strings.Contains(h.log.String(), "nobody") || !strings.Contains(h.log.String(), "Failed login for alice.") {
		t.Errorf("log: %s", h.log)
	}
	// The request checks of every API call.
	good := `{"username":"alice","password":"` + password + `"}`
	for name, r := range map[string]req{
		"no header":      {method: http.MethodPost, path: "/api/login", body: good, noKey: true},
		"foreign origin": {method: http.MethodPost, path: "/api/login", body: good, header: map[string]string{Header: "x", "Origin": "https://evil.example"}},
		"form":           {method: http.MethodPost, path: "/api/login", body: good, header: map[string]string{Header: "x", "Content-Type": "application/x-www-form-urlencoded"}},
		"cross-site":     {method: http.MethodPost, path: "/api/login", body: good, header: map[string]string{Header: "x", "Sec-Fetch-Site": "cross-site"}},
		"GET":            {path: "/api/login", header: map[string]string{Header: "x"}},
		"extra field":    {method: http.MethodPost, path: "/api/login", body: `{"username":"alice","password":"` + password + `","admin":true}`, header: map[string]string{Header: "x"}},
	} {
		if resp, b := h.do(r); resp.StatusCode < 400 || len(resp.Cookies()) > 0 {
			t.Errorf("%s: %d %s", name, resp.StatusCode, b)
		}
	}
	out := h.passwordLogin("Alice", password)
	if out["mustChangePassword"] != false {
		t.Error(out)
	}
	if st := h.status(); st.User != "alice" || !st.Admin || !st.LocalUser {
		t.Errorf("%+v", st)
	}
	if strings.Contains(h.log.String(), password) {
		t.Error("the password is in the log")
	}
	// Delays after failures, also with the right password.
	for range 5 {
		h.public("/api/login", `{"username":"alice","password":"wrong"}`)
	}
	resp, b := h.public("/api/login", good)
	if resp.StatusCode != http.StatusTooManyRequests || resp.Header.Get("Retry-After") != "1" || !strings.Contains(b, "Too many failed attempts") {
		t.Errorf("%d %v %s", resp.StatusCode, resp.Header, b)
	}
	clk.add(time.Second)
	// A new login replaces the browser's session.
	old := h.client()
	old.cookie, old.key = h.cookie, h.key
	h.passwordLogin("alice", password)
	if code := old.code(req{path: "/api/status"}); code != http.StatusUnauthorized {
		t.Errorf("old session: %d", code)
	}
}

func TestMustChangePassword(t *testing.T) {
	h, store := startLocal(t, nil, nil)
	addUser(t, store, "alice", users.RoleUser, true)
	if out := h.passwordLogin("alice", password); out["mustChangePassword"] != true {
		t.Fatal(out)
	}
	if st := h.status(); !st.MustChangePassword {
		t.Errorf("%+v", st)
	}
	if code, b := h.post("/api/fetch", `{"token":"`+token+`"}`); code != http.StatusForbidden || !strings.Contains(b, "change your password first") {
		t.Errorf("%d %s", code, b)
	}
	if code, b := h.post("/api/password", `{"current":"`+password+`","password":"`+password+` 2"}`); code != http.StatusOK {
		t.Fatalf("%d %s", code, b)
	}
	if st := h.status(); st.MustChangePassword {
		t.Error("still must change")
	}
	if code, b := h.post("/api/fetch", `{"token":"`+token+`"}`); code != http.StatusAccepted {
		t.Errorf("%d %s", code, b)
	}
	h.wait()
}

func TestPasswordChangeEndsOtherSessions(t *testing.T) {
	a, store := startLocal(t, nil, nil)
	addUser(t, store, "alice", users.RoleUser, false)
	addUser(t, store, "bob", users.RoleUser, false)
	b, bob := a.client(), a.client()
	a.passwordLogin("alice", password)
	b.passwordLogin("alice", password)
	bob.passwordLogin("bob", password)
	if code, body := a.post("/api/password", `{"current":"wrong","password":"`+password+` 2"}`); code != http.StatusBadRequest || !strings.Contains(body, "current password is wrong") {
		t.Errorf("%d %s", code, body)
	}
	if code, body := a.post("/api/password", `{"current":"`+password+`","password":"alice"}`); code != http.StatusBadRequest || !strings.Contains(body, "at least 12") {
		t.Errorf("%d %s", code, body)
	}
	if code, body := a.post("/api/password", `{"current":"`+password+`","password":"`+password+` 2"}`); code != http.StatusOK {
		t.Fatalf("%d %s", code, body)
	}
	if code := b.code(req{path: "/api/status"}); code != http.StatusUnauthorized {
		t.Errorf("alice's other session: %d", code)
	}
	a.status()
	bob.status()
	b.passwordLogin("alice", password+" 2")
	if code, _ := a.post("/api/logout-others", "{}"); code != http.StatusOK {
		t.Error(code)
	}
	if code := b.code(req{path: "/api/status"}); code != http.StatusUnauthorized {
		t.Errorf("after logout-others: %d", code)
	}
	a.status()
	if !strings.Contains(a.log.String(), "Session ended: password changed or sessions ended.") {
		t.Error(a.log.String())
	}
}

func TestAdminAPI(t *testing.T) {
	admin, store := startLocal(t, nil, nil)
	addUser(t, store, "root", users.RoleAdmin, false)
	bob := addUser(t, store, "bob", users.RoleUser, false)
	user := admin.client()
	admin.passwordLogin("root", password)
	user.passwordLogin("bob", password)

	// Users are not admins.
	if code := user.code(req{path: "/api/users"}); code != http.StatusForbidden {
		t.Errorf("list as user: %d", code)
	}
	if code, _ := user.post("/api/users/add", `{"username":"eve","role":"admin"}`); code != http.StatusForbidden {
		t.Errorf("add as user: %d", code)
	}

	// Add: a link to pass on.
	code, body := admin.post("/api/users/add", `{"username":"Carol","name":"Carol C.","role":"user"}`)
	var added struct{ ID, Link string }
	if code != http.StatusOK || json.Unmarshal([]byte(body), &added) != nil || !strings.HasPrefix(added.Link, "https://explorer.example/#link=") {
		t.Fatalf("%d %s", code, body)
	}
	if code, body := admin.post("/api/users/add", `{"username":"carol","role":"user"}`); code != http.StatusConflict {
		t.Errorf("same name: %d %s", code, body)
	}
	if code, body := admin.post("/api/users/add", `{"username":"dave","role":"root"}`); code != http.StatusBadRequest {
		t.Errorf("bad role: %d %s", code, body)
	}
	resp, b := admin.do(req{path: "/api/users"})
	var list struct{ Users []UserInfo }
	if resp.StatusCode != http.StatusOK || json.Unmarshal(b, &list) != nil || len(list.Users) != 3 || !list.Users[1].Pending || list.Users[1].Name != "Carol C." ||
		!list.Users[2].You || list.Users[0].Pending || strings.Contains(string(b), "argon2") {
		t.Errorf("%s", b)
	}

	// Carol opens the link: who it is for, then her password; she is logged in.
	carol := admin.client()
	linkCode := strings.TrimPrefix(added.Link, "https://explorer.example/#link=")
	if resp, b := carol.public("/api/link", `{"code":"`+linkCode+`"}`); resp.StatusCode != http.StatusOK || !strings.Contains(b, `"username":"carol"`) {
		t.Errorf("link info: %d %s", resp.StatusCode, b)
	}
	if resp, b := carol.public("/api/link/password", `{"code":"`+linkCode+`","password":"carol"}`); resp.StatusCode != http.StatusBadRequest {
		t.Errorf("weak password: %d %s", resp.StatusCode, b)
	}
	resp, b2 := carol.public("/api/link/password", `{"code":"`+linkCode+`","password":"`+password+`"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("set password: %d %s", resp.StatusCode, b2)
	}
	carol.cookie = resp.Cookies()[0]
	carol.readKey()
	if st := carol.status(); st.User != "Carol C." || st.Admin {
		t.Errorf("%+v", st)
	}
	if resp, _ := carol.public("/api/link/password", `{"code":"`+linkCode+`","password":"`+password+` 2"}`); resp.StatusCode != http.StatusGone {
		t.Errorf("link used twice: %d", resp.StatusCode)
	}

	// Role: bob becomes admin in his running session.
	if code, body := admin.post("/api/users/role", `{"id":"`+bob.ID+`","role":"admin"}`); code != http.StatusOK {
		t.Fatalf("%d %s", code, body)
	}
	if st := user.status(); !st.Admin {
		t.Error("role change not seen by the session")
	}
	// Reset: bob's session ends, he gets a new link.
	code, body = admin.post("/api/users/reset", `{"id":"`+bob.ID+`"}`)
	if code != http.StatusOK || !strings.Contains(body, "#link=") {
		t.Fatalf("%d %s", code, body)
	}
	if code := user.code(req{path: "/api/status"}); code != http.StatusUnauthorized {
		t.Errorf("bob after reset: %d", code)
	}
	// Disable and delete end sessions too.
	if code, _ := admin.post("/api/users/disable", `{"id":"`+carolID(t, store)+`"}`); code != http.StatusOK {
		t.Fatal(code)
	}
	if code := carol.code(req{path: "/api/status"}); code != http.StatusUnauthorized {
		t.Errorf("carol after disable: %d", code)
	}
	if code, _ := admin.post("/api/users/enable", `{"id":"`+carolID(t, store)+`"}`); code != http.StatusOK {
		t.Fatal(code)
	}
	carol.passwordLogin("carol", password)
	if code, _ := admin.post("/api/users/delete", `{"id":"`+carolID(t, store)+`"}`); code != http.StatusOK {
		t.Fatal(code)
	}
	if code := carol.code(req{path: "/api/status"}); code != http.StatusUnauthorized {
		t.Errorf("carol after delete: %d", code)
	}

	// Not on one's own account; unknown ids and actions.
	root, _ := store.Find("root")
	for _, action := range []string{"disable", "delete", "reset", "role"} {
		if code, body := admin.post("/api/users/"+action, `{"id":"`+root.ID+`","role":"user"}`); code != http.StatusBadRequest || !strings.Contains(body, "own account") {
			t.Errorf("%s self: %d %s", action, code, body)
		}
	}
	if code, _ := admin.post("/api/users/disable", `{"id":"nope"}`); code != http.StatusNotFound {
		t.Error(code)
	}
	if code, _ := admin.post("/api/users/promote", `{"id":"`+bob.ID+`"}`); code != http.StatusNotFound {
		t.Error(code)
	}
	if !strings.Contains(admin.log.String(), "] User carol: add user.") || strings.Contains(admin.log.String(), linkCode) {
		t.Error(admin.log.String())
	}
}

func carolID(t *testing.T, store *users.Store) string {
	t.Helper()
	u, ok := store.Find("carol")
	if !ok {
		t.Fatal("no carol")
	}
	return u.ID
}

func TestChangedFileEndsSessions(t *testing.T) {
	// The users command changes the file while the server runs.
	h, store := startLocal(t, nil, nil)
	u := addUser(t, store, "alice", users.RoleUser, false)
	h.passwordLogin("alice", password)
	other, err := users.Open(strings.TrimSuffix(strings.TrimSuffix(store.Path(), "/users.json"), "/v1"), users.Options{Params: users.Params{Memory: 64, Time: 1, Threads: 1}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := other.SetDisabled(u.ID, true); err != nil {
		t.Fatal(err)
	}
	if code := h.code(req{path: "/api/status"}); code != http.StatusUnauthorized {
		t.Errorf("disabled by the command: %d", code)
	}
}
