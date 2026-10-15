// Package httpx is the exporter's only way onto the network: an HTTP client
// that can send nothing but GET and HEAD, only to an explicit list of hosts,
// never follows redirects, and adds the credentials itself so they cannot
// end up anywhere else.
package httpx

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// MaxBody caps a single response. Even depth=4 server lists of large
// contracts are a few MB.
const MaxBody = 256 << 20

// Credentials authenticate against the IONOS APIs. Use a token where
// possible; username and password are supported for accounts without one.
type Credentials struct {
	Token    string
	Username string
	Password string
}

func (c Credentials) header() string {
	if c.Token != "" {
		return "Bearer " + c.Token
	}
	if c.Username != "" {
		return "Basic " + base64.StdEncoding.EncodeToString([]byte(c.Username+":"+c.Password))
	}
	return ""
}

// Valid reports whether credentials are set.
func (c Credentials) Valid() bool { return c.header() != "" }

// String never reveals the secret, should Credentials end up in a log line.
func (c Credentials) String() string {
	switch {
	case c.Token != "":
		return "token"
	case c.Username != "":
		return "user " + c.Username
	}
	return "none"
}

type Options struct {
	Credentials Credentials
	// Hosts the client may talk to (host or host:port). Anything else is
	// refused before a connection is made.
	Hosts     []string
	UserAgent string
	// ContractNumber selects a contract for users with access to several
	// (X-Contract-Number). Optional.
	ContractNumber string
	// Retries of 429, 5xx and network errors. Default 5.
	Retries int
	// First retry delay, doubled each time. Default 1s.
	Backoff time.Duration
	// Per-request timeout. Default 3m: depth=4 lists of big datacenters are slow.
	Timeout time.Duration
	// Transport underneath the guards; http.DefaultTransport when nil.
	Transport http.RoundTripper
}

type Client struct {
	http    *http.Client
	retries int
	backoff time.Duration
	timeout time.Duration
	sleep   func(context.Context, time.Duration) error
}

func New(o Options) *Client {
	if o.Retries == 0 {
		o.Retries = 5
	}
	if o.Backoff == 0 {
		o.Backoff = time.Second
	}
	if o.Timeout == 0 {
		o.Timeout = 3 * time.Minute
	}
	base := o.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	hosts := map[string]bool{}
	for _, h := range o.Hosts {
		hosts[strings.ToLower(h)] = true
	}
	return &Client{
		http: &http.Client{
			Transport: &guard{hosts: hosts, next: &headers{opts: o, auth: o.Credentials.header(), next: base}},
			// A redirect could point anywhere; treat it as an error instead.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		retries: o.Retries,
		backoff: o.Backoff,
		timeout: o.Timeout,
		sleep:   sleep,
	}
}

// ErrRefused is returned for requests the guard does not let through.
var ErrRefused = errors.New("request refused")

// guard is the outermost transport: it checks every request, including any
// a future code path might build by hand, before anything else sees it.
type guard struct {
	hosts map[string]bool
	next  http.RoundTripper
}

func (g *guard) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return nil, fmt.Errorf("%w: method %s (the exporter is read-only)", ErrRefused, r.Method)
	}
	if !g.hosts[strings.ToLower(r.URL.Host)] {
		return nil, fmt.Errorf("%w: host %q is not an IONOS API host", ErrRefused, r.URL.Host)
	}
	if r.URL.Scheme != "https" && !(r.URL.Scheme == "http" && loopback(r.URL.Hostname())) {
		return nil, fmt.Errorf("%w: %s:// (credentials only travel over https)", ErrRefused, r.URL.Scheme)
	}
	if r.Body != nil && r.Body != http.NoBody {
		return nil, fmt.Errorf("%w: request body", ErrRefused)
	}
	return g.next.RoundTrip(r)
}

func loopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

type headers struct {
	opts Options
	auth string
	next http.RoundTripper
}

func (h *headers) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	if h.auth != "" {
		r.Header.Set("Authorization", h.auth)
	}
	if h.opts.ContractNumber != "" {
		r.Header.Set("X-Contract-Number", h.opts.ContractNumber)
	}
	if h.opts.UserAgent != "" {
		r.Header.Set("User-Agent", h.opts.UserAgent)
	}
	r.Header.Set("Accept", "application/json")
	return h.next.RoundTrip(r)
}

// Response is a finished request. Body is only set for 2xx.
type Response struct {
	Status int
	Body   []byte
	// Error is the API's error message for non-2xx responses.
	Error    string
	Attempts int
}

// Get fetches rawURL, retrying rate limits (429), server errors and network
// failures. A non-2xx status is not an error; the caller decides what it
// means. Errors are network failures after all retries, or refusals.
func (c *Client) Get(ctx context.Context, rawURL string) (*Response, error) {
	if _, err := url.Parse(rawURL); err != nil {
		return nil, err
	}
	delay := c.backoff
	for attempt := 1; ; attempt++ {
		resp, wait, err := c.once(ctx, rawURL)
		if resp != nil {
			resp.Attempts = attempt
		}
		retry := wait > 0 || (err != nil && !errors.Is(err, ErrRefused) && ctx.Err() == nil)
		if !retry || attempt > c.retries {
			if err != nil {
				return nil, err
			}
			return resp, nil
		}
		if wait < delay {
			wait = delay
		}
		delay *= 2
		if err := c.sleep(ctx, wait); err != nil {
			return nil, err
		}
	}
}

// once makes a single request. wait > 0 asks for a retry after that long.
func (c *Client) once(ctx context.Context, rawURL string) (resp *Response, wait time.Duration, err error) {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, 0, err
	}
	r, err := c.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer r.Body.Close()
	body, err := io.ReadAll(io.LimitReader(r.Body, MaxBody+1))
	if err != nil {
		return nil, 0, err
	}
	if len(body) > MaxBody {
		return nil, 0, fmt.Errorf("%w: response larger than %d MB", ErrRefused, MaxBody>>20)
	}
	resp = &Response{Status: r.StatusCode}
	switch {
	case r.StatusCode >= 200 && r.StatusCode < 300:
		resp.Body = body
	case r.StatusCode == http.StatusTooManyRequests:
		resp.Error = apiError(r.StatusCode, body)
		wait = retryAfter(r.Header)
		if wait <= 0 {
			wait = time.Nanosecond // use the backoff
		}
	case r.StatusCode >= 500:
		resp.Error = apiError(r.StatusCode, body)
		wait = time.Nanosecond
	default:
		resp.Error = apiError(r.StatusCode, body)
	}
	return resp, wait, nil
}

// retryAfter reads Retry-After in seconds; HTTP dates fall back to the backoff.
func retryAfter(h http.Header) time.Duration {
	if s, err := strconv.Atoi(strings.TrimSpace(h.Get("Retry-After"))); err == nil && s > 0 {
		return min(time.Duration(s)*time.Second, 5*time.Minute)
	}
	return 0
}

// apiError extracts the message of an IONOS error response,
// {"httpStatus": 403, "messages": [{"errorCode": "...", "message": "..."}]}.
func apiError(status int, body []byte) string {
	var e struct {
		Messages []struct {
			ErrorCode string `json:"errorCode"`
			Message   string `json:"message"`
		} `json:"messages"`
	}
	var parts []string
	if json.Unmarshal(body, &e) == nil {
		for _, m := range e.Messages {
			if m.ErrorCode != "" {
				parts = append(parts, "["+m.ErrorCode+"] "+m.Message)
			} else if m.Message != "" {
				parts = append(parts, m.Message)
			}
		}
	}
	msg := strings.Join(parts, "; ")
	if msg == "" {
		msg = fmt.Sprintf("HTTP %d %s", status, http.StatusText(status))
	}
	if len(msg) > 500 {
		msg = msg[:500] + "…"
	}
	return msg
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
