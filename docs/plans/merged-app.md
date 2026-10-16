# Merged application: one binary that fetches and shows

**Problem.** Today a user runs `ionos-export` in a terminal, gets a file,
and drops it onto the explorer, which they have to serve themselves
(`npm run dev` or a static build). That is two tools and a file on disk
for every look at the contract. The user has lifted the rule that the UI
never touches the IONOS API, with these decisions (verbatim answers):

- **One Go binary** `ionos-explorer` serves the UI (embedded) on
  127.0.0.1 and fetches from IONOS itself; the browser only talks to
  localhost.
- **Token typed into the UI**: entered on a page served by the local
  program, sent once to it, held in memory only (never stored).
- **Keep both old modes**: `ionos-export` stays for machines that should
  only fetch; the UI still opens `.ionx` files (shared snapshots, the
  demo), and the static build without a backend keeps working (the fetch
  feature is hidden there).
- **Fetched data in memory only**: no snapshots folder; nothing touches
  disk unless the user presses Download (`.ionx`, optionally
  age-encrypted).

## Design

```
browser (127.0.0.1 only)                 ionos-explorer (Go)                      IONOS
┌──────────────────────────┐  /api/*     ┌──────────────────────────────┐  GET   ┌──────────┐
│ explorer UI (embedded)   │ ──────────► │ local server: secret, cookie │ ─────► │ Cloud API│
│ token field → POST once  │ ◄────────── │ token in memory, one fetch,  │ ◄───── │ product  │
│ snapshot bytes → model   │  .ionx bytes│ export.Run (same crawl), zip │        │ APIs     │
└──────────────────────────┘             └──────────────────────────────┘        └──────────┘
```

- `exporter/cmd/ionos-explorer`: flags, listen check, start the server,
  print the login URL, open the browser.
- `exporter/internal/server`: the local HTTP server (auth, checks, the
  fetch job, static files). Everything testable with `httptest`.
- `exporter/internal/webui`: the UI as an `fs.FS`. With the build tag
  `embedui` it embeds `internal/webui/dist` (`//go:embed all:dist`), which
  `make explorer-app` fills from `explorer/dist`; without the tag (plain
  `go build`, `go test`, `go vet`) a one-page placeholder says how to build
  with the UI. The tag keeps the Go tests independent of a UI build and
  leaves no tracked file that a build overwrites. `dist/` is git-ignored.
- `internal/export` gets a `Planned` callback (requests added to the plan,
  so the UI can show "done of total") and a `Generator` name; context
  cancellation and the per-request `Progress` callback already exist.
  `ionos-export` passes neither and behaves as before.
- The `--base-url` / API host logic moves from `cmd/ionos-export` to
  `internal/endpoints` (`Bases`) so both commands share it.

Flags: `--listen` (default `127.0.0.1:0`, a free port; only loopback
addresses are accepted), `--open` (default on: open the browser),
`--base-url` (as in `ionos-export`, for `internal/fakeapi`),
`--forget-after` (default 30m: drop a held token after that long unused),
`--version`.

### Flow in the UI

- Backend detection: the server marks the `index.html` it serves with
  `<meta name="ionos-explorer">`; only then does the page call `GET
  /api/status` (JSON with `app: "ionos-explorer"` → ready; no session key
  in this tab → "open the printed link"; no answer → "not answering").
  Without the tag (static build, plain `npm run dev`) nothing is shown and
  no request is made. (First planned: probe `/api/status` everywhere; that
  logs a 404 on every static host.)
- Open screen: a "Fetch from IONOS" panel (only with a backend): token
  (password field, `autocomplete="off"`, uncontrolled, read once on
  submit and cleared, never React state), "Keep the token in memory for
  Refresh" (on), optional skip list and contract number (the two
  `ionos-export` settings that matter), Fetch. While fetching: requests
  done of planned, problems, Cancel.
- Result: `POST /api/fetch/result` returns the snapshot bytes once; the
  server drops its copy. The bytes are loaded like an opened file.
- Top bar, with a backend: "Refresh" (same panel in a dialog; no token
  field while one is held), "Download" for a fetched snapshot (plain
  `.ionx`, or `.ionx.age` with a passphrase or an age recipient, encrypted
  in the browser with `age-encryption`), and "token held ✕" (✕ forgets).
- On a fetch while a snapshot is open, the open one becomes the
  comparison base (Changes tab, markers) if it is of the same contract and
  older; otherwise the new one opens without a comparison.

### Token: kept until Forget, exit, a 401, or 30 minutes unused

Decision: the server keeps the token in process memory between fetches
so Refresh needs no retyping (the user allowed this). It is dropped on
"Forget token", on exit, when IONOS answers 401, after `--forget-after`
without a fetch, and right after the fetch when "Keep the token" is off.
The UI always shows whether a token is held. The token is held as a
`[]byte` that is zeroed when dropped; the `Authorization` header string
`net/http` needs cannot be zeroed and is left to the garbage collector
(written down as a limit).

## API between UI and local server

All under `/api/`, JSON, `Cache-Control: no-store`. Every call needs the
session cookie and the `X-Ionos-Explorer` header (below). POSTs need
`Content-Type: application/json`, a matching `Origin`, and a body of at
most 64 KiB.

| Call | Body | Answer |
|---|---|---|
| `GET /api/status` | | `{app, version, tokenHeld, tokenForgetAt?, fetch?: {state, done, total, problems, error?, resultReady, startedAt, finishedAt?}}` |
| `POST /api/fetch` | `{token?, keep, skip?: [..], contractNumber?}` | 202 + status; 409 while one runs; 400 without a token held or given |
| `POST /api/fetch/cancel` | `{}` | status |
| `POST /api/fetch/result` | `{}` | `application/octet-stream` snapshot, once; 404 when none |
| `POST /api/forget` | `{}` | status |

Progress by polling `/api/status` (every 400 ms while running): an
`EventSource` cannot send the custom header.

## Security

- Listen on loopback only (`127.0.0.1`, `::1`, `localhost`); anything
  else is refused at start. No flag to override yet.
- Two per-run secrets from `crypto/rand`: the **login secret** in the
  printed URL `http://127.0.0.1:<port>/login?secret=…`, and a **session**
  (cookie value + API key). `GET /login` with the right secret sets the
  cookie `ionos-explorer-<port>` (HttpOnly, SameSite=Strict, Path=/) and
  redirects to `/#session=<key>`; the UI moves the key into
  `sessionStorage` and removes it from the address bar. The page and the
  API need the cookie (Jupyter's model); the API also needs the key in
  `X-Ionos-Explorer`. Why both: browsers send cookies for 127.0.0.1 to
  every port, so a page on another local port (another user's server) the
  user visits would receive the cookie; `sessionStorage` is per origin
  (port included), so the key stays with this page. The custom header
  also means no cross-site form or simple request can reach the API.
- `Host` must be the listen address (`127.0.0.1:<port>` or
  `localhost:<port>`): DNS rebinding gets 421.
- State-changing requests: `Origin` must be `http://<allowed host>`;
  `Sec-Fetch-Site`, when sent, must be `same-origin`.
- No CORS headers at all; `OPTIONS` gets 405.
- `--open` does not put the secret on a command line (other local users
  can read those): it writes a 0600 HTML file that redirects to the login
  URL into a fresh 0700 temp folder, opens that, and deletes it after the
  first login or on exit. The URL is also printed (to the user's terminal).
- The token never goes into logs, URLs, error messages, responses or the
  snapshot: it only arrives in a POST body; any error text is scrubbed of
  it before it is stored; tests grep every response and the log.
- Requests to IONOS go through `internal/httpx` as before: GET/HEAD only,
  listed hosts only, https except loopback, no redirects. Redaction of
  secret fields unchanged.
- Headers on every response: the CSP of the build (same string as
  `vite.config.ts`, a Go test compares them) plus `frame-ancestors
  'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy` and
  `-Resource-Policy: same-origin`.
- One fetch at a time; bodies size-limited; server timeouts set.
- Memory only: the server writes no files (a test runs a fetch with an
  empty working and temp directory and checks both stay empty).

## Dev mode

`go run ./cmd/ionos-explorer --listen 127.0.0.1:8642 --open=false` and
`npm run dev`: Vite proxies `/api` and `/login` to it (target from
`IONOS_EXPLORER_URL`, default `http://127.0.0.1:8642`), with the `Host`
and `Origin` rewritten to the target; open the printed URL with the port
changed to 5173.

## Tests

- Go `internal/server`: login (wrong/right secret, cookie flags, redirect
  without the secret), page and API without cookie or key, wrong `Host`,
  wrong or missing `Origin`, `Sec-Fetch-Site: cross-site`, wrong content
  type, oversize body, `OPTIONS` without CORS headers, security headers on
  every response; fetch against `fakeapi` (progress done = total at the
  end, result is a valid snapshot, taken once), cancel, wrong token
  (message, token dropped), 409 for a second fetch, token not in any
  response or log (also when the API echoes it in an error), forget and
  idle forget, nothing written to disk, CSP equal to `vite.config.ts`.
- Go `cmd/ionos-explorer`: non-loopback refused, URL printed, flags.
- Go `internal/export`: `Planned` adds up to the number of `Progress`
  calls; existing tests unchanged.
- vitest: session key from the hash, backend detection (JSON, 401, 404,
  HTML), the API client's headers, base selection (same contract and
  older only), download file names, in-browser encryption round trip.
- Browser (playwright, binary + fakeapi): login link, page refused
  without it, fetch, canvas, second fetch → Changes compares, Download
  (plain and encrypted), Forget, wrong token message, cancel; static build
  without backend shows no fetch panel; light/dark, 390 px, keyboard, no
  console errors, no requests to other hosts.

## Accept

- `make explorer-app` builds `bin/ionos-explorer` with the UI; running it
  opens the browser on the explorer, a token fetches the contract, and
  nothing is written to disk until Download.
- `make test` passes; `ionos-export` behaviour and tests unchanged.
- The static build (`npm run build`, any static host) works as before
  and shows no fetch feature.

## Left over

Done 2026-10-15. Notes and deviations:

- **Code.** Go: `cmd/ionos-explorer` (flags, listen check, launcher
  file), `internal/server` (`server.go`: secrets, login, Host check,
  headers, static files; `api.go`: status, fetch job, result, forget,
  idle timer), `internal/webui` (embed with tag `embedui`, placeholder
  without). `internal/export`: `Config.Planned` and `Config.Generator`.
  `internal/endpoints.Bases` (moved from `cmd/ionos-export`, unchanged).
  `internal/httpx`: `Credentials.Scrub`, applied to every API error
  message. UI: `src/backend/` (`backend.ts`, `useBackend.ts`,
  `snapshots.ts`, `encrypt.ts`), `src/ui/FetchPanel.tsx`,
  `src/ui/SnapshotDialogs.tsx` (Refresh and Download as `<dialog>`),
  `App.tsx` (state `fetched`, top-bar actions), `OpenScreen.tsx`,
  `main.tsx` (takes the session key before anything reads the hash),
  `vite.config.ts` (dev proxy, comment corrected), `Makefile`
  (`explorer-app`), `.gitignore` (`/exporter/internal/webui/dist/`).
- **Decisions.** Build tag rather than a committed placeholder `dist/`:
  `go test`/`go vet` need no UI build and no tracked file changes on a
  build. `--listen 127.0.0.1:0` (a free port; the secret changes per run
  anyway, so a fixed port buys nothing); `--open` on by default.
  `--forget-after 30m`. Polling at 400 ms, not SSE (`EventSource` cannot
  send the session header). Snapshots fetched here say `generator:
  ionos-explorer` (schema enum and SNAPSHOT_FORMAT updated; old explorers
  only display the name). The comparison base is whatever snapshot is open
  (fetched, file or demo) if same contract and older.
- **Deviations from the plan above.** (1) Detection by a meta tag the
  server adds to `index.html`, not by probing `/api/status`: a static host
  would log a 404 on every load; now the static build makes no request at
  all (checked). A tab with no session key does not ask either (a 401 is
  logged as a console error). (2) `/login` answers with a page that moves
  on by itself (`<meta http-equiv="refresh">`) instead of a 303: Chrome
  does not send a SameSite=Strict cookie at the end of a redirect chain
  that started cross-site (the launcher file). Checked with the real
  launcher file: logged in. (3) Session key in `sessionStorage` added to
  the cookie (the plan had it; the user's brief had the cookie only): it
  closes the cross-port cookie leak, see ARCHITECTURE. (4) "Keep the token
  in memory" checkbox (default on). (5) `age-encryption` is now loaded only
  when a file is encrypted or a download encrypted (`load.ts` imports it
  dynamically): adding `Encrypter` would have pushed the main chunk over
  500 kB; now 468 → 374.5 kB (age 130.9 kB on its own, `encrypt.ts`
  0.6 kB). (6) The top bar's actions (token held ✕, Refresh, Download,
  Open another snapshot) are one group that wraps as a whole, right
  aligned (at 1400 px with the backend it takes a second row; before,
  "Open another snapshot" ended up alone on the left). (7) Changes says
  "less than a minute" / "12 minutes" / "3 hours" for snapshots fetched
  the same day instead of "0 days" (`timeBetween`).
- **Encryption in the browser was cheap**: `age-encryption`'s
  `Encrypter` (passphrase via scrypt, X25519 and post-quantum recipients)
  was already a dependency. No new dependency anywhere; NOTICE unchanged.
- **Tests.** Go: `internal/server` 15 tests (login, page, headers, Host,
  cookie+key, request checks, fetch, one-at-a-time + cancel, wrong token,
  token leaks, zeroing, idle forget, memory only, listen addresses, CSP =
  vite.config.ts); `cmd/ionos-explorer` 3 (login link served, launcher
  file 0600/0700 removed on exit and no secret on the command line,
  refused flags/addresses); `internal/export` +2 (Planned adds up to
  Progress, cancel); `internal/httpx` +1 (credentials scrubbed, also when
  the 500-character cut would split them). 25 → 46 top-level Go tests,
  all pass with `-race`. vitest 194 → 220 (backend client and detection,
  session key handling, comparison base with the demo pair, file names,
  passphrase and recipient round trips, refusals, skip parsing, progress
  text, `timeBetween`). `make test` passes, oxlint 0 warnings.
  `ionos-export` and its tests are unchanged (it shares `endpoints.Bases`
  and gains the error scrubbing).
- **Browser (binary from `make explorer-app` + a throwaway fake API
  serving the demo, previous state on the first crawl, current after;
  built from a temporary `cmd/` dir that was deleted).** `/` without login
  403 "Not logged in"; wrong secret 403; `/api/status` as a navigation 403
  (Sec-Fetch-Site). Login link → address `http://127.0.0.1:8642/` (no
  secret, no key), key in `sessionStorage`, `document.cookie` empty
  (HttpOnly). Wrong token: "The IONOS API rejected the token (HTTP 401).
  Check it and enter it again.", field emptied. Token by keyboard + Enter:
  progress "21 of 36 requests · 2 could not be read" with Cancel, then the
  canvas (14 cards), "token held ✕", Download. Refresh dialog: no token
  field, "held in memory (forgotten at 21:56 if unused)"; Fetch again →
  dialog closes, focus back on Refresh, "Changes 19", markers on the
  canvas, Changes "From … to … (less than a minute)". Download plain:
  `ionos-31812345-20261015T192635Z.ionx`, zip; passphrase mismatch
  refused; encrypted `.ionx.age` starts with `age-encryption.org/v1`; a bad
  recipient "Not an age recipient: age1nope". Escape closes dialogs, focus
  returns. Reload keeps the session (sessionStorage), the snapshot is gone
  (memory). Forget → token field back. A second tab with the cookie but no
  key: "This tab is not logged in…". Cancel (slow fake): "Cancelled.",
  token kept. Launcher file via a stand-in `xdg-open`: 0600 in a 0700
  folder, login works through it, folder gone 2 s after login. Static
  build (`vite preview`): no fetch panel, original fine print, demo loads,
  0 `/api` requests, CSP meta present. Dev proxy
  (`IONOS_EXPLORER_URL=… npm run dev`): login via :5175, fetch, canvas.
  Light/dark, 1400 and 390 px: no horizontal overflow (open screen,
  canvas, dialogs). Tab order on the open screen: token → keep → Options →
  Fetch → drop area → demo. No console errors or warnings besides the 403s
  of the deliberate refusals, no requests to other hosts. The working
  directory and `TMPDIR` of the program stayed empty. Screenshots in the
  scratchpad (`shots-merged/`).
- **Limits.** Go strings (the `Authorization` header, the decoded JSON)
  cannot be overwritten; they live until garbage-collected. The login
  secret stays valid for the run and ends up in the browser's history
  (the `/login?secret=…` entry): anyone who can read this user's browser
  profile during the run could log in; it is worthless after exit.
  Cookies are shared across ports of 127.0.0.1: another local server the
  user visits gets the session cookie, but without the key it can do
  nothing beyond loading the (public) UI files. No TLS (loopback only).
  The launcher file does not work with browsers that cannot read the temp
  folder (some snap packages); the printed link does. The `--open` command
  is only checked on Linux (`xdg-open`); `open` (macOS) and `rundll32`
  (Windows) untested. The progress total grows once (when the top-level
  lists are in), so the bar jumps back then. An untaken result stays in
  the server's memory until taken, the next fetch, or exit. Only one fetch
  at a time across all tabs; whichever tab polls first takes the result.
  Never run against the real IONOS API here (rule); only `fakeapi`.
- **Not done.** TLS or non-loopback listening; SSE; keeping more than
  the last snapshot in memory (a history to pick the base from); storing
  the token in an OS keychain; a time limit for untaken results.
