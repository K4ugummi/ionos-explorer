# 01 Hosted mode and sessions

**Problem.** `internal/server` is built for one person on 127.0.0.1: one
login secret printed to the terminal, one cookie, one held IONOS token, one
fetch job and one result in the `Server` struct, and `CheckListen` refuses
anything but loopback. In a container the program must listen on all
interfaces of the container, behind TLS terminated by an ingress, for
several users at once.

## Design

- **Mode.** `--mode local|hosted` (`IONOS_EXPLORER_MODE`). `local` is
  today's behaviour, unchanged (all current tests keep passing). `hosted`:
  - listens on any address (default `:8080`); refuses to start without
    `PUBLIC_URL` and a login method (package 02; until 02 exists, hosted
    mode can only start in tests with a fake authenticator);
  - no printed login link, no launcher file, no `--open`;
  - plain HTTP inside the container (TLS is the ingress's job), but cookies
    are `Secure` and `__Host-` prefixed whenever `PUBLIC_URL` is https.
- **Base path:** `PUBLIC_URL` may have a path; every route (UI files,
  `/api/*`, `/login`, `/callback`, health) lives under it, the UI is built
  with relative asset URLs (`base: './'` in Vite) and reads the API base
  from the page, cookies get that `Path`. A `__Host-` cookie must have
  `Path=/`, so under a sub-path the prefix is `__Secure-` instead. Tested
  with `/` and `/tools/ionos-explorer`.
- **Host check** against `PUBLIC_URL`'s host only (DNS rebinding and
  wrong-vhost protection). `X-Forwarded-*` headers are not trusted for
  anything security-relevant: the scheme and host come from `PUBLIC_URL`.
  Health endpoints (package 04) are exempt from the Host check because
  kubelet probes use the pod IP.
- **Origin check** on every API request as today, compared with
  `PUBLIC_URL`'s origin. The custom header requirement stays (forms and
  simple cross-site requests cannot send it).
- **Sessions.** A `session` struct holds what `Server` holds today for its
  one user: held token (`[]byte`, zeroed on drop), keep flag, idle timer,
  fetch job, result, plus user identity (package 02) and the per-session
  key the UI sends in its header. `Server` keeps
  `map[sessionID]*session` under a mutex. Session ID: 32 random bytes,
  cookie `__Host-ionos-explorer` (`__Secure-` under a sub-path; HttpOnly, Secure, SameSite=Lax: Strict
  would drop the cookie on the redirect back from the IdP), rotated at
  login. Absolute TTL (default 12h) and idle TTL (default 2h); expired
  sessions are removed by a janitor, their token zeroed, their job
  cancelled.
- **Local mode on top of sessions.** Local mode becomes "one session,
  created by the secret login link"; same code path, so both modes share
  the fetch/token logic and its tests.
- **Limits.** One fetch per session (as today); at most `MAX_FETCHES`
  (default 2) running over all sessions; further requests get 429 with
  "n fetches are running, try again in a minute" (no queue: the UI already
  polls status). A finished result is kept until taken or 10 minutes,
  then dropped (memory). Request bodies stay at 64 KiB.
- **Logout** (`POST /api/logout`): drops the session (token zeroed, job
  cancelled). With 02 it also ends the IdP session if the IdP supports
  RP-initiated logout.
- **Log lines** carry a session-short-id and (with 02) the user's subject,
  never tokens, cookies or the session key.

## Tests

- Mode/config validation: hosted without `PUBLIC_URL`, with `http://`
  non-localhost, without an authenticator → refuses to start with a clear
  message; local mode unchanged (existing tests).
- Two sessions fetch at once (fake API), each gets only its own status,
  result and token state; session A's cookie with session B's key → 403.
- `MAX_FETCHES`: third concurrent fetch → 429; after one ends → accepted.
- Session expiry (fake clock): token zeroed, job cancelled, cookie refused.
- Host and Origin checks against `PUBLIC_URL`; `X-Forwarded-Host` ignored.
- Cookie attributes for https vs `http://localhost` public URL.
- Logout drops exactly that session.

## Accept

- All existing `internal/server` tests pass unchanged in local mode.
- Two browser contexts against a hosted server (fake authenticator in a
  test build only) fetch the demo at the same time and see only their own
  progress and result.
