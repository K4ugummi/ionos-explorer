package httpx

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func server(t *testing.T, h http.HandlerFunc) (*httptest.Server, string) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	return srv, u.Host
}

func TestGuardRefusesWritesAndForeignHosts(t *testing.T) {
	var hits atomic.Int64
	srv, host := server(t, func(http.ResponseWriter, *http.Request) { hits.Add(1) })
	c := New(Options{Credentials: Credentials{Token: "secret"}, Hosts: []string{host}})

	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		req, _ := http.NewRequest(method, srv.URL+"/datacenters", strings.NewReader("{}"))
		if _, err := c.http.Do(req); !errors.Is(err, ErrRefused) {
			t.Errorf("%s: %v", method, err)
		}
	}
	for _, u := range []string{"http://127.0.0.2:1/x", "http://example.com/x", "https://api.ionos.com.evil.example/x"} {
		if _, err := c.Get(context.Background(), u); !errors.Is(err, ErrRefused) {
			t.Errorf("%s: %v", u, err)
		}
	}
	if hits.Load() != 0 {
		t.Errorf("%d refused requests reached the server", hits.Load())
	}

	// Plain http is only allowed to loopback (tests, local mocks).
	plain := New(Options{Hosts: []string{"api.ionos.com"}})
	if _, err := plain.Get(context.Background(), "http://api.ionos.com/cloudapi/v6/datacenters"); !errors.Is(err, ErrRefused) {
		t.Errorf("http to a remote host: %v", err)
	}
}

func TestHeadersAndNoRedirects(t *testing.T) {
	var leaked atomic.Value
	_, other := server(t, func(_ http.ResponseWriter, r *http.Request) { leaked.Store(r.Header.Get("Authorization")) })
	srv, host := server(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "http://"+other+"/x", http.StatusFound)
			return
		}
		fmt.Fprintf(w, `{"auth":%q,"contract":%q,"ua":%q}`, r.Header.Get("Authorization"), r.Header.Get("X-Contract-Number"), r.UserAgent())
	})
	// Even with the other host allowed, a redirect is not followed.
	c := New(Options{Credentials: Credentials{Token: "tkn"}, Hosts: []string{host, other}, ContractNumber: "42", UserAgent: "ionos-export/test"})
	r, err := c.Get(context.Background(), srv.URL+"/ok")
	if err != nil || string(r.Body) != `{"auth":"Bearer tkn","contract":"42","ua":"ionos-export/test"}` {
		t.Fatalf("%v %s", err, r.Body)
	}
	r, err = c.Get(context.Background(), srv.URL+"/redirect")
	if err != nil || r.Status != http.StatusFound || r.Body != nil {
		t.Errorf("redirect: %v %+v", err, r)
	}
	if leaked.Load() != nil {
		t.Error("the redirect was followed")
	}

	basic := Credentials{Username: "u@example.com", Password: "pw"}
	if basic.header() != "Basic dUBleGFtcGxlLmNvbTpwdw==" || strings.Contains(basic.String(), "pw") {
		t.Errorf("%s / %s", basic.header(), basic)
	}
	if (Credentials{Token: "tkn"}).String() != "token" || (Credentials{}).Valid() {
		t.Error("String/Valid")
	}
}

func TestRetries(t *testing.T) {
	var calls atomic.Int64
	srv, host := server(t, func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		switch {
		case r.URL.Path == "/flaky" && n == 1:
			w.Header().Set("Retry-After", "7")
			w.WriteHeader(http.StatusTooManyRequests)
		case r.URL.Path == "/flaky" && n == 2:
			w.WriteHeader(http.StatusBadGateway)
		case r.URL.Path == "/down":
			w.WriteHeader(http.StatusServiceUnavailable)
			fmt.Fprint(w, `{"httpStatus":503,"messages":[{"errorCode":"SVC","message":"maintenance"}]}`)
		case r.URL.Path == "/forbidden":
			w.WriteHeader(http.StatusForbidden)
			fmt.Fprint(w, `{"httpStatus":403,"messages":[{"errorCode":"VDC-14-1","message":"Access denied"}]}`)
		default:
			fmt.Fprint(w, `{}`)
		}
	})
	c := New(Options{Hosts: []string{host}, Retries: 3, Backoff: time.Second})
	var waits []time.Duration
	c.sleep = func(_ context.Context, d time.Duration) error { waits = append(waits, d); return nil }

	r, err := c.Get(context.Background(), srv.URL+"/flaky")
	if err != nil || r.Status != 200 || r.Attempts != 3 {
		t.Fatalf("%v %+v", err, r)
	}
	if fmt.Sprint(waits) != "[7s 2s]" {
		t.Errorf("waits %v", waits)
	}

	calls.Store(0)
	r, err = c.Get(context.Background(), srv.URL+"/down")
	if err != nil || r.Status != 503 || r.Error != "[SVC] maintenance" || calls.Load() != 4 {
		t.Errorf("%v %+v after %d calls", err, r, calls.Load())
	}

	calls.Store(0)
	r, err = c.Get(context.Background(), srv.URL+"/forbidden")
	if err != nil || r.Status != 403 || r.Error != "[VDC-14-1] Access denied" || calls.Load() != 1 {
		t.Errorf("%v %+v after %d calls", err, r, calls.Load())
	}

	// Cancellation stops the retries.
	ctx, cancel := context.WithCancel(context.Background())
	c.sleep = func(ctx context.Context, d time.Duration) error { cancel(); return ctx.Err() }
	if _, err := c.Get(ctx, srv.URL+"/down"); !errors.Is(err, context.Canceled) {
		t.Errorf("cancel: %v", err)
	}
}

func TestAPIError(t *testing.T) {
	if got := apiError(404, []byte("not json")); got != "HTTP 404 Not Found" {
		t.Error(got)
	}
	if got := apiError(400, []byte(`{"messages":[{"message":"a"},{"errorCode":"B","message":"b"}]}`)); got != "a; [B] b" {
		t.Error(got)
	}
	if got := apiError(500, []byte(`{"messages":[{"message":"`+strings.Repeat("x", 600)+`"}]}`)); len(got) > 510 {
		t.Error(len(got))
	}
}
