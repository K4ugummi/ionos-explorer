# Architecture

IONOS Explorer gives a read-only, contract-wide view of an IONOS Cloud
account: one search across all virtual datacenters and a 2D diagram of every
datacenter and the Cross Connects between them. It exists because the DCD
works one datacenter at a time and has no global search.

The project is built to be generic (planned to be open-sourced). It must work for any
IONOS contract, from one datacenter to hundreds:

- **No assumptions about naming or topology.** Nothing keys off names like
  `transit` or `fw`. Structure comes only from API references (NIC → LAN →
  Cross Connect, …). Heuristics (e.g. appliance detection) are data-driven
  rule lists that users can extend, and the explorer always shows *why* a
  heuristic fired.
- **Graceful with partial data.** Any endpoint can be forbidden, missing in a
  region, or return fields we do not know. Unknown fields are kept and shown
  in the raw view; unknown resource types are still searchable.
- **Layout scales.** The overview must stay readable for 1, 14 and 200+
  datacenters (grouping by location, collapsing, filtering).
- **Fixtures are examples, not the target.** The demo contract is one
  plausible enterprise setup; additional generated profiles (minimal,
  large-scale stress) guard against overfitting.

## Guiding constraint: the browser never touches the IONOS API

Only Go code with a read-only, GET-only HTTP client talks to IONOS. The
explorer UI in the browser talks to nothing but the server it was loaded
from. There are two ways to run it:

```
1. One program (ionos-explorer, local)

   browser, 127.0.0.1 only              ionos-explorer (Go)                         IONOS APIs
   ┌──────────────────────────┐  /api   ┌───────────────────────────────────┐  GET  ┌──────────┐
   │ explorer UI (embedded)   │ ──────► │ login secret, cookie + session key│ ────► │ Cloud API│
   │ token typed once → POST  │ ◄────── │ token in memory, one fetch at once│ ◄──── │ product  │
   │ snapshot bytes → model   │  .ionx  │ same crawl as ionos-export        │       │ APIs     │
   └──────────────────────────┘         └───────────────────────────────────┘       └──────────┘

2. Two programs (a machine that only fetches, files shared)

   ┌──────────────────────┐   snapshot file    ┌─────────────────────────────┐
   │  ionos-export (Go)   │ ─────────────────► │  explorer (static build)    │
   │  read-only token     │  .ionx             │  no credentials, no backend │
   │  GET requests only   │  .ionx.age (opt.)  │  no outbound network (CSP)  │
   └──────────────────────┘                    └─────────────────────────────┘
```

Both write and read the same **snapshot format**
([SNAPSHOT_FORMAT.md](SNAPSHOT_FORMAT.md), [schema](../schema/manifest.schema.json)):
`ionos-explorer` runs the crawl of `ionos-export` (`internal/export`) and
hands the browser exactly the file `ionos-export` would have written, kept
in memory. The UI opens it like a dropped file.

| Concern | ionos-export / ionos-explorer (Go) | Explorer UI (browser) |
|---|---|---|
| Credentials | IONOS token: env/file (`ionos-export`) or typed into the page and posted once to the local program (`ionos-explorer`); never argv, logs, URLs, output | never holds one beyond the submit |
| Network | `api.ionos.com` and product API hosts, GET/HEAD only; `ionos-explorer` also listens on loopback | only its own origin: CSP `connect-src 'self'`; served by `ionos-explorer`, that is the local server |
| Logic | fetch, paginate, record coverage, write raw JSON | parse, normalize, index, lay out, render |
| Change rate | rarely (new endpoint = new list entry) | often |

The crawl stays deliberately "dumb": it stores API responses unchanged
(only re-serialized canonically). All interpretation lives in the explorer,
so mapping bugs are fixed without re-exporting and the audit surface of
the Go code stays small.

## Components

### Exporter (`exporter/`, Go)

- `cmd/ionos-export`: the CLI. `--list` prints every request it can make
  without needing credentials or network.
- `cmd/ionos-explorer`: the single binary. Serves the explorer UI on
  127.0.0.1 and runs the crawl when the page asks (see *ionos-explorer*
  below). Flags: `--listen` (default `127.0.0.1:0`, a free port; loopback
  only), `--open` (default on), `--base-url` (a local mock),
  `--forget-after` (default 30m), `--version`.
- `cmd/ionos-fixture`: generates a synthetic 14-datacenter contract in the
  exact snapshot format, for development and tests.
- `internal/endpoints`: the explicit list of endpoints the exporter calls.
  Reviewing this file is reviewing what the tool can read: the Cloud API,
  Cloud DNS, the databases (PostgreSQL, MariaDB, MongoDB, In-Memory DB),
  Kafka, Network File Storage, VPN Gateway, Certificate Manager, CDN,
  Container Registry, Logging and Monitoring, VM Auto Scaling. Regional
  APIs are listed once per region, the regions taken from the servers of
  each API's OpenAPI document. Endpoints that hand out credentials (Kafka
  user access, registry tokens, kubeconfigs, SSO URLs) are never listed,
  and a test keeps it so.
- `internal/httpx`: the only network access. Its transport refuses anything
  but GET/HEAD, any host but the configured API hosts, plain http except to
  loopback, and request bodies. Redirects are not followed. It adds the
  credentials itself and retries 429 (honouring `Retry-After`), 5xx and
  network errors with exponential backoff.
- `internal/export`: runs the plan (top-level collections, then one request
  per datacenter / cluster), up to `--parallel` requests at a time. It
  reports each finished request (`Progress`) and how many were added to the
  plan (`Planned`: the top-level ones, then per child endpoint once its
  parent is known), so a caller can show "done of total"; a cancelled
  context stops it.
  Pagination is driven by `offset`/`limit`, or by the cursor an API
  returns (`pagination.token`: DNS, the Container Registry; a cursor seen
  twice ends the list with an error), never by following `_links.next`
  (MongoDB: `links.next`), and pages are merged. Fields that may hold a
  secret are blanked in every answer (`password`, `privateKey`,
  `secretKey`, `userData`, …), and per endpoint where the name is too
  common to blank everywhere (`key` of Logging and Monitoring pipelines;
  a label's `key` stays). Ids from responses become URL path
  segments only if they look like ids. Coverage records every request's
  outcome; when a parent is not readable, its children are recorded as
  `skipped` with the reason.
- `internal/snapshot`: container writer/reader (zip, manifest, checksums,
  optional age encryption). Shared by both commands.
- `internal/fakeapi`: serves a snapshot back as the IONOS API would
  (paginated, with error bodies), so tests run the exporter end to end
  against the demo contract and check that it reproduces it byte for byte.
- `internal/server`: the local web server of `ionos-explorer` (security
  checks, the fetch job, the UI files). Everything below is tested with
  `httptest` against `fakeapi`.
- `internal/webui`: the UI as an `fs.FS`. With the build tag `embedui` it
  embeds `internal/webui/dist`, which `make explorer-app` fills with the
  explorer's production build; without the tag (plain `go build`, `go
  test`, `go vet`) it is a one-page placeholder that says how to build with
  the UI. So the Go code builds and tests without Node, and no tracked file
  is overwritten by a build (`dist/` is git-ignored).

No IONOS SDK: plain `net/http` keeps the dependency tree tiny and preserves
every field the API returns (SDKs drop fields they don't model).

`ionos-export` runs non-interactively, so the same binary works for manual runs and CI/cron.
Exit codes: `0` complete, `2` written but partial (some endpoints
forbidden/failed; endpoints excluded with `--skip` don't count), `1` failed
and nothing written (including HTTP 401 on the first request).

`ionos-export` takes credentials from `--token-file`, `IONOS_TOKEN`, or
`IONOS_USERNAME`/`IONOS_PASSWORD`, never from arguments. They are not
logged, not part of any error message, and not in the snapshot. Output files
are written atomically with mode 0600 and not overwritten without `--force`.

**Credentials (recommended):** a dedicated non-admin IONOS user in a group
with *read* shares on all datacenters. New datacenters are not shared
automatically. The exporter records `forbidden` coverage and the explorer
surfaces "partial visibility" rather than silently showing less.

### ionos-explorer: the local server

`ionos-explorer` binds the listen address first (a free port by default),
then prints `http://127.0.0.1:<port>/login?secret=…` and, with `--open`,
opens the browser on it. The page works as with a static host (files, the
demo) and in addition shows *Fetch from IONOS*:

- **Detection.** The server adds `<meta name="ionos-explorer">` to the
  `index.html` it serves. Only with that tag does the page call
  `/api/status`; a static build makes no such request. A tab without a
  session key (opened by hand) says to use the printed link; a server that
  stopped is reported as not answering.
- **Fetch.** The token field is an uncontrolled password field
  (`autocomplete="off"`), read once on submit, cleared at once and posted
  with the options (skip list, contract number, "keep the token"); it is
  never React state. `POST /api/fetch` starts the crawl (one at a time;
  409 otherwise). The page polls `GET /api/status` every 400 ms (an
  `EventSource` could not send the session header) for requests done of
  planned and those that could not be read, with Cancel. When it is done,
  `POST /api/fetch/result` returns the snapshot bytes once and the server
  drops its copy; the page opens them like a file and keeps them in memory
  for Download. A fetch still running when the page is reloaded is
  followed again; a result nobody took is offered ("Open it") and dropped
  by the next fetch.
- **Comparison from memory.** A fetch while a snapshot is open makes the
  open one the comparison base (`comparisonBase`), if it is of the same
  contract and older; the Changes tab and markers then show what changed
  since, with no file on disk. Another contract opens without comparison.
- **Download** (top bar, for a fetched snapshot): plain `.ionx` or
  `.ionx.age`, encrypted in the browser with `age-encryption` to a
  passphrase (scrypt) or age recipients, named like `ionos-export` names
  its files. That is the only way fetched data reaches the disk.
- **Token held.** The server keeps the token in process memory for
  Refresh until "Forget token", exit, an HTTP 401 from IONOS, or
  `--forget-after` (30 minutes) without a fetch; with "Keep the token" off
  it is dropped when the fetch ends. The top bar shows "token held" with a
  ✕ to forget it; the fetch panel says until when.

API (all JSON, `Cache-Control: no-store`, session cookie and
`X-Ionos-Explorer` key required, POSTs with `Content-Type:
application/json`, same `Origin`, at most 64 KiB):

| Call | Body | Answer |
|---|---|---|
| `GET /api/status` | | `{app, version, tokenHeld, tokenForgetAt?, fetch?: {state, done, total, problems, error?, resultReady, size?, startedAt, finishedAt?}}` |
| `POST /api/fetch` | `{token?, keep, skip?, contractNumber?}` | 202 + status; 409 while one runs; 400 without a token |
| `POST /api/fetch/cancel` | `{}` | status |
| `POST /api/fetch/result` | `{}` | the snapshot (`application/octet-stream`), once; 404 when none |
| `POST /api/forget` | `{}` | status (also cancels a running fetch) |
| `POST /api/logout` | `{}` | hosted mode: `{app, next}`, the session ends and the browser goes to `next` (the login screen, or the OIDC provider's logout) |

Hosted mode adds the login and account calls (below). `GET /api/status`
then also answers `user`, `admin`, `localUser` and `mustChangePassword`.

The page calls these with relative URLs (`api/status`) and is built with
relative asset URLs (Vite `base: './'`), so it works below any path.

Dev mode: `IONOS_EXPLORER_URL=http://127.0.0.1:8642 npm run dev` proxies
`/api` and `/login` to a running `ionos-explorer --listen
127.0.0.1:8642` (with `Host` and `Origin` rewritten to it, so its checks
pass) and marks the page like the server does; without the variable dev
mode behaves like the static build.

### Hosted mode (`--mode hosted`)

For a team: the same program on a server or in a container, behind a
proxy that terminates TLS, each user with a session of their own. Local
mode stays the default and unchanged; both modes share one code path,
local mode being "one session, opened by the printed link".

- **Configuration** by flag or environment (`IONOS_EXPLORER_` + flag name,
  `--public-url` → `IONOS_EXPLORER_PUBLIC_URL`; a flag wins), or from the
  file the same name with `_FILE` names (a Docker or Kubernetes secret;
  one trailing line break is dropped; setting both is an error). Hosted mode
  needs `--public-url` (https, or http for localhost to try it out; it may
  have a path, `https://tools.example.com/ionos-explorer`) and a login
  method. It listens on `:8080` by default, prints no link and opens no
  browser. Hosted-only flags in local mode are refused.
- **Login methods:** local user accounts (built in, the default) and/or
  any number of `Authenticator`s (the OIDC providers, one button each):
  each serves its own routes below the base path (`/login/<id>`,
  `/callback/<id>`; overlapping routes are refused) and ends a login with
  `LoginFunc`, which starts the session. Without any, hosted mode refuses
  to start.
- **Sessions.** Each login gets a new session (the browser's previous one
  ends): cookie value and session key from `crypto/rand`; the server keeps
  only the cookie's SHA-256. A session holds what the local server held
  for its one user: the token, the keep flag, the fetch, the result.
  `--session-ttl` (12 h) after login or `--session-idle` (2 h) without a
  request it ends: fetch cancelled, token zeroed, result dropped. A
  janitor checks every 30 s, and every request checks its own session.
  `POST /api/logout` ends one session. Sessions, tokens and results are
  in memory: a restart logs everyone out, and there is exactly one
  instance. Only the user accounts and (with a key) the snapshot history
  are on the volume.
- **The page** gets the session key in the `index.html` it is served
  (`<meta name="ionos-explorer-session">`, next to the marker
  `content="hosted"`), so every tab of a logged-in browser has it. The UI
  files themselves are public (they hold no data): without a session the
  page shows the login screen. The top bar and the fetch panel show who
  is logged in; their account dialog changes the password, ends the other
  sessions, logs out and (admins) manages users.
- **Limits.** One fetch per session, at most `--max-fetches` (2) over all
  sessions (429 "n fetches are running, try again in a minute"); a result
  nobody took is dropped after 10 minutes.
- **Logs** name the session (the first 8 hex digits of its id) and the
  user's subject, with control characters and spaces replaced; never a
  token, cookie, key or password. `--log-format json` writes one JSON
  object per line instead (`time`, `level`, `msg`, and `session`/`user`
  for a session's events, `link` for the setup link), for log collectors.
- **Probes** at the root, whatever the base path, without login or Host
  check (Docker and Kubernetes ask by the container's address):
  `GET /healthz` is `ok` while the process serves; `GET /readyz` is `ok`
  while it can serve users: not shutting down, the user accounts readable
  and their directory writable, the history folder writable, and a login
  provider that can tell
  (`Readier`) working. Otherwise 503 with a short reason; the details
  (paths, errors) go to the log, once per change.
  `ionos-explorer healthcheck [--ready]` asks them on the listen port, for
  Docker's `HEALTHCHECK` (the image has no curl).
- **Shutdown** on SIGTERM or Ctrl+C: fetches cancelled, tokens zeroed,
  results dropped at once; requests under way (a snapshot download) get up
  to 10 s; `/readyz` says "shutting down".

### Container image (`Dockerfile`)

Three stages: the UI built with Node, both commands cross-compiled with Go
(`$BUILDPLATFORM`, so arm64 builds without emulation; `CGO_ENABLED=0`,
`-trimpath`, version by `--build-arg VERSION`), and the runtime on
`gcr.io/distroless/static-debian13:nonroot`: no shell or package manager,
CA certificates, about 22 MB. Base images are pinned by digest.

- Runs as 65532:65532; `/data` belongs to 65532 with group 0 and mode
  0770, so a random UID with group 0 (OpenShift) works as well. The program
  needs no home directory or passwd entry and writes nothing outside
  `DATA_DIR`, so the root filesystem can be read-only.
- `IONOS_EXPLORER_MODE=hosted` is the image's default; the rest has
  defaults (`:8080`, `/data`) or must be given (`PUBLIC_URL`). The image
  has no local mode use: local mode only listens on the container's own
  loopback. A single person runs the binary, or the image with
  `http://localhost:8080` as public URL, published to 127.0.0.1.
- `.dockerignore` lets in only `explorer/`, `exporter/`, the demo
  fixtures, `LICENSE` and `NOTICE`, and keeps out every other `*.ionx`,
  `*.age`, `*.token` and `.env*` wherever it lies, so a real snapshot in
  the working copy cannot reach a build context or image layer.
- `ionos-export` is in the image too (`--entrypoint ionos-export`).
- A second target, `fakeapi` (`docker build --target fakeapi`), holds
  `ionos-fakeapi`: the synthetic demo contract served like the IONOS API,
  one fixed token, for trials and CI. It is never in the release image.
  Because the explorer sends a token over plain http only to loopback, the
  fake shares its network namespace (Compose `network_mode`, a second
  container in the Kubernetes pod).

### Deployment (`deploy/`)

Docker Compose (with an optional Caddy for TLS, and a dev file with the
fake API), Kubernetes with Kustomize (base under the `restricted` Pod
Security Standard, a NetworkPolicy, an example overlay with ingress and
cert-manager, a component for the first admin from a Secret, a dev
overlay for kind), and a Swarm stack. All run exactly one instance; see
`deploy/README.md`.

### Local users (`internal/users`)

Accounts kept by the explorer itself, so a team needs no identity
provider. On by default in hosted mode (`--local-users=false` for OIDC
only); they need `--data-dir` (default `/data`, must exist).

- **Store:** `DATA_DIR/v1/users.json` (folder 0700, file 0600): per user a
  random id, username (lower case, `[a-z0-9._@-]{1,64}`), name, role
  (`admin` or `user`), argon2id hash, must-change flag, disabled, created,
  last login, and a session epoch; plus pending one-time links, by the
  SHA-256 of their code only. Each change is made under an exclusive file
  lock (`flock`) on the file's current content, written to a temporary
  file, synced and renamed; readers notice a changed file. So the
  `ionos-explorer users` command can change it while the server runs. A
  file that cannot be read is reported and never overwritten.
- **Passwords:** argon2id (64 MiB, 3 passes, 1 thread; PHC string, so the
  parameters can rise later and old hashes are redone at the next login).
  Rules after NIST SP 800-63B: 12 to 256 characters, not the username, not
  one of 46,146 common passwords of that length (from SecLists'
  1-million list, `make common-passwords`); no composition rules.
- **Logging in** (`POST /api/login` from the login screen; JSON with the
  header, the Origin, content type and size checks of every API call, the
  CSP keeps `form-action 'none'`): unknown users, users without a password,
  disabled users and wrong passwords get the same answer after the same
  work (a dummy hash is checked). After 5 failures of a username, known or
  not, every attempt waits 1 s, 2 s, 4 s … up to 15 minutes, the right
  password included (429 with `Retry-After`); no permanent lockout, which
  would let anyone lock out the admin. At most 2 hashes run at once (the
  others wait up to 3 s, then 503). Client IPs are not used: behind a
  proxy they are the proxy's. The counters are in memory.
- **First admin:** with `--admin-password-file` (a Docker or Kubernetes
  secret) at the first start, and the password must be changed at the
  first login; otherwise the log shows a one-time link
  (`PUBLIC_URL/#setup=…`, valid 1 hour, renewed on expiry and at each
  start while there are no users) whose page creates the first admin.
- **More accounts:** an admin adds a user and passes on the one-time link
  (`PUBLIC_URL/#link=…`, 24 hours) to set the password; the explorer sends
  no mail. Codes travel in the fragment: no server or proxy log, no
  Referer. Reset (password removed, new link), disable, role and delete
  are in the Users dialog and the `users` command; nobody changes their
  own account there, and the last enabled admin cannot be disabled,
  demoted or deleted.
- **Sessions follow the account:** every request of a local user's
  session reads the account. Deleted, disabled, or a newer session epoch
  (password changed or reset, "Log out other sessions") ends the session;
  a new name or role shows at once. A must-change account can only change
  its password or log out.
- **Second factor (TOTP)**, `--local-totp off|optional|required`
  (default `optional`): RFC 6238 as authenticator apps do it (HMAC-SHA-1,
  6 digits, 30 s, one step either side), written here with the RFC's test
  vectors. It needs the age identity of the snapshot history
  (`--age-identity-file`): the secret is kept in `users.json`
  age-encrypted to it (`"totp": "age:…"`), and `rekey` re-encrypts it
  too. Without the identity it is not offered (`required` refuses to
  start); accounts that have one cannot log in until it is back, or until
  `users reset-totp` removes it.
  - **Setting up** (Account dialog): `begin` makes a 160-bit secret, held
    in the session for 10 minutes; the page draws the QR code of the
    `otpauth://` address itself (qrcode-generator, nothing leaves the
    page) and shows the key; `enable` needs the password and a code of
    that secret, ends the other sessions, and answers 10 recovery codes
    (50 random bits each, `xxxxx-xxxxx`), shown once, kept only as
    SHA-256. New codes and turning it off need the password; with
    `required` it cannot be turned off, and an account without one can
    only set it up or log out.
  - **Logging in** takes two requests: the right password answers a
    ticket instead of a session (random, only its hash kept, 5 minutes,
    5 tries, bound to the account); `POST /api/login/code` with the ticket
    and a code (or a recovery code) starts the session. A code works
    once (the last step used is stored). Wrong codes count as failed
    logins of the username, and with a second factor a right password no
    longer clears the count, so knowing the password buys no fresh
    guesses.
  - **Lost phone:** a recovery code, or an admin's "Reset two-factor"
    (Users dialog, `users reset-totp`), which ends the sessions.

| Call (hosted) | Session | Body | Answer |
|---|---|---|---|
| `GET /api/login-methods` | no | | `{app, local, setup?, providers: [{label, url, unavailable?}]}` |
| `POST /api/login` | no | `{username, password}` | cookie + `{app, mustChangePassword}`; 401, 429 |
| `POST /api/setup` | no | `{code, username, name, password}` | the first admin, logged in |
| `POST /api/link` | no | `{code}` | `{app, username, name}` of a link |
| `POST /api/link/password` | no | `{code, password}` | password set, logged in; 410 for a used link |
| `POST /api/password` | yes | `{current, password}` | status; the other sessions end |
| `POST /api/logout-others` | yes | `{}` | status |
| `GET /api/users` | admin | | `{app, users: [{id, username, name, role, disabled, pending, mustChangePassword, locked, created, lastLogin, you}]}` |
| `POST /api/users/add` | admin | `{username, name, role}` | `{app, id, link}` |
| `POST /api/users/reset`, `/disable`, `/enable`, `/delete` | admin | `{id}` | `{app, link?}` |
| `POST /api/users/role` | admin | `{id, role}` | `{app}` |
| `POST /api/users/reset-totp` | admin | `{id}` | `{app}` |
| `POST /api/login` (second factor) | no | `{username, password}` | `{app, secondFactor: true, ticket}`, no cookie |
| `POST /api/login/code` | no | `{ticket, code}` | cookie; 401 wrong code, 410 ticket used up or expired |
| `POST /api/totp/begin` | yes | `{}` | `{app, key, uri}` |
| `POST /api/totp/enable` | yes | `{password, code}` | `{app, recoveryCodes, status}`; the other sessions end |
| `POST /api/totp/recovery` | yes | `{password}` | `{app, recoveryCodes}` |
| `POST /api/totp/disable` | yes | `{password}` | status; 403 where required |

### OIDC providers (`internal/oidc`)

Any number of OpenID Connect providers (Keycloak, Entra ID, Google, …),
next to local users or instead of them: `--oidc-providers keycloak,entra`
and per provider `IONOS_EXPLORER_OIDC_<ID>_ISSUER`, `_CLIENT_ID`,
`_CLIENT_SECRET` (each also `_FILE`), `_NAME`, `_SCOPES`, `_GROUPS_CLAIM`,
`_ALLOWED_GROUPS`, `_ALLOWED_EMAILS`, `_ADMIN_GROUPS`. Provider IDs are
`[a-z0-9-]{1,32}`; an `IONOS_EXPLORER_OIDC_…` variable that belongs to no
listed provider or setting stops the start (a typo would otherwise drop an
allow list silently). Libraries: `github.com/coreos/go-oidc/v3` and
`golang.org/x/oauth2`, the only code here that verifies signatures of
others.

- **Flow:** authorization code with PKCE (S256) for a confidential client,
  `state` and `nonce` per attempt. `GET /login/<id>` seals the attempt
  (provider, state, nonce, PKCE verifier, expiry 10 minutes) with AES-GCM
  under a key made at start into a cookie that goes only to that
  provider's callback (`__Secure-ionos-explorer-login-<id>`, path
  `…/callback/<id>`, HttpOnly, Lax: the way back is a cross-site
  navigation); nothing about the attempt is kept in the server, so
  unauthenticated requests cannot fill its memory. `GET /callback/<id>`
  clears the cookie, refuses a missing, forged, expired or other
  provider's attempt, a different `state`, an answer that names another
  issuer (`iss`, RFC 9207) and a state that already logged in (kept until
  the attempt would have expired), exchanges the code with the verifier,
  and verifies the ID token.
- **ID token:** signature against the provider's JWKS (fetched with the
  discovery document, refreshed when a token names an unknown key),
  algorithms limited to RS/PS/ES 256–512 and EdDSA (never `none`, never
  HS*, which would make the client secret a signing key) and to those the
  discovery offers; `iss`; `aud` contains the client ID, and with several
  audiences or any `azp`, `azp` is the client ID; `exp` and `iat` with
  2 minutes of clock skew; `nonce` (constant-time); a subject.
- **Who:** the session's subject is `oidc:<id>:<sub>`, its name `name`,
  `preferred_username`, `email` or `sub`. Allowed are members of an
  allowed group (from `GROUPS_CLAIM`, default `groups`, a list or one
  string; `a.b` reads nested claims such as Keycloak's
  `realm_access.roles`), users whose email is in the allowed list
  (exact address or `@domain`, lower case, only with `email_verified`
  true) and admins (members of an admin group); with no lists, everyone
  the provider lets log in to the client (logged at start). A refused
  user sees their name (escaped) and a link to log out at the provider;
  the attempt is logged with its subject.
- **Logout:** the session ends as for every user; then, if the discovery
  names an `end_session_endpoint`, `POST /api/logout` answers it as
  `next` (RP-initiated logout with `id_token_hint`, `client_id`,
  `post_logout_redirect_uri` = the public URL). The ID token is kept in
  the session for that only; access and refresh tokens are not kept, and
  nothing of the provider's is logged or written.
- **Availability:** each provider fetches its discovery document in the
  background at start and again (5 s, doubling up to 2 minutes) until it
  answers. Meanwhile its button is disabled (`unavailable` in
  `/api/login-methods`) and `/login/<id>` says it cannot be reached;
  `/readyz` is ready when local users work or one provider has answered.
  An identity provider's errors (`error`, `error_description`) are shown
  escaped and cut to 200 characters; failed checks only say "failed" in
  the page and why in the log.
- **Issuer:** https, or http only when the public URL is http too (a trial
  on localhost with the Compose profile `dev-idp`).
- **Tested** against an in-process provider (`internal/oidc/fake_test.go`:
  discovery, JWKS, single-use codes, PKCE): two providers, wrong or
  replayed state, another provider's attempt, replayed code, wrong
  verifier, wrong nonce, audience, azp, issuer, expired, `iat` in the
  future, `alg: none`, HS256, unknown key, key rotation, allow lists,
  provider down.

### Snapshot history (`internal/history`)

With an age identity (`--age-identity-file`, `IONOS_EXPLORER_AGE_IDENTITY_FILE`;
`ionos-explorer keygen` prints a new one), hosted mode keeps every
successful fetch in the user's own history on the volume, so a restart
loses nothing and the Changes tab can compare with yesterday or last
month. Without it there is no history (logged at start) and fetches stay
in memory as before. Local mode has none.

- **Private per user.** `DATA_DIR/v1/history/u-<first 128 bits of
  SHA-256 of the subject>/<contract>/<UTC time>-<8 random hex>.ionx.age`,
  and the same name with `.meta.age` (what the list shows: time, contract,
  collections, problems, size; so listing decrypts no snapshot). The
  subject is `local:<user id>` or `oidc:<provider>:<sub>`; no name or
  email is on the volume, only hashes, contract numbers (or `unknown`) and
  times. There is no shared history and no admin access to another
  user's: every call takes the caller's subject, never a path, and IDs
  (`<contract>-<time>-<random>`) are matched against a pattern before they
  name a file.
- **Encrypted** with age (X25519) to the first identity in the file;
  reading tries all of them. Files 0600 in folders 0700, written to a
  hidden temporary file, synced and renamed (a crash leaves no partial
  snapshot; leftovers are removed after an hour). The browser never holds
  the server's key: `GET /api/history/<id>` answers the decrypted
  snapshot to its owner.
- **Key rotation:** put the new identity first in the file, the old one
  after it, restart, run `ionos-explorer rekey` (encrypts every file the
  first identity cannot read to it), then drop the old identity. Losing
  every identity loses the history; nothing else.
- **When:** after a successful fetch, before it is handed out (a fetch
  with partial errors too, marked partial); failed or cancelled fetches
  and fetches of a session that ended are not stored. The fetch status
  says `historyId`, or `historyError` when it could not be stored (the
  snapshot is handed out all the same).
- **Retention** per user and contract (`--keep`, default
  `daily=14,weekly=8,monthly=12`): the newest 3, and the newest of each of
  the last 14 days, 8 weeks (Monday to Sunday) and 12 months, UTC. Applied
  after each store, at start and hourly. **Quota** per user
  (`--max-user-bytes`, default 500 MB, encrypted size): when a new
  snapshot would exceed it, the oldest beyond the newest 3 of each
  contract go first; if that is not enough, nothing is deleted and the
  snapshot is not stored.
- **Deleting a user** (Users dialog or `users delete`) deletes their
  history. `/readyz` checks that the history folder takes files.
- **UI:** the open screen lists the history by contract ("Open latest",
  the 5 newest, "Show all", delete with a confirmation in the page); the
  Changes tab offers the history of the open snapshot's contract before
  files; a fetch, or a snapshot opened from the history, is compared with
  the newest older snapshot in the history by itself (unless the snapshot
  open before it already is its base). "Download" works for both.

| Call (hosted, history on) | Body | Answer |
|---|---|---|
| `GET /api/history[?contract=<n>\|unknown]` | | `{app, entries: [{id, contract, createdAt, collections, problems, partial, size, stored, version}], used, quota?}`, newest first |
| `GET /api/history/<id>` | | the snapshot (`application/octet-stream`); 404 for anything not the caller's |
| `POST /api/history/delete` | `{id}` | `{app}`; 404 as above |

### Explorer (`explorer/`, Vite + React + TypeScript)

Single-page app. Local-first: served by `ionos-explorer`, or as a static
build from anywhere: open it and drop a snapshot in. A static build can
later sit behind nginx + oauth2-proxy (SSO) for a team, with no code
changes (it has no fetch feature there).

Modules:

- `src/snapshot`: unzip (fflate), decrypt (`age-encryption`, the TS port
  of age, loaded only for an encrypted file), verify checksums against the
  manifest.
- `src/backend`: talking to `ionos-explorer` (`backend.ts`: session key,
  detection, API client; `useBackend.ts`: state, polling, taking the
  result; `snapshots.ts`: comparison base, file names; `encrypt.ts`:
  encrypting a download).
- `src/model`: raw API → normalized graph:
  - **Node** `{id, kind, name, dcId, parentId, labels, searchText, raw}`
  - **Edge** `{kind, from, to}`: `nic→lan`, `lan↔pcc`, `lb→lan`,
    `lb→target`, `natgw→lan`, `server→volume`, `nodepool→lan`,
    `dbaas→lan` (PostgreSQL, MariaDB, MongoDB, In-Memory DB, Kafka, NFS:
    `LAN_SERVICES` in `kinds.ts`, drawn in their LAN's datacenter and part
    of the network graph), `ipblock→consumer`, `record→resource`
    (`resolves-to`: an A/AAAA record or reverse record to whatever has the
    IP, a CNAME/ALIAS/MX/NS/SRV to the address records of the name it
    names or the service answering there; the name becomes a search term
    of the resource), `cdn|alb→certificate`, `cdn→origin` (`upstream`),
    `autoscaling→server` (`manages`)
  - **Flags** for `is:` searches: certificates `expiring` (within 30 days
    of the snapshot's date) and `expired`; DNS records `dangling` (an IP no
    resource has, or a name in one of the contract's zones nothing answers
    at). Kafka topics and registry repositories are facts and search terms
    of their cluster or registry, not nodes.
- `src/search`: in-memory full-text index (names, IDs, IPs, MACs, labels)
  with filters such as `type:cube dc:fra-prod-core ip:10.7.*`. Every hit shows
  its path: contract › datacenter › LAN › server.
- `src/diagram`: React Flow (xyflow) for rendering, ELK.js (in a web worker)
  for layout. A diagram is pure data derived from the model, with fixed node
  sizes so it can be laid out before rendering. ELK routes every edge
  orthogonally; the user can move boxes afterwards (*own positions*, below).
  Two levels (the focus and path views below build on them):
  1. **Contract**: datacenter cards grouped by location, packed to fit the
     screen. Cross Connects with exactly two peer datacenters draw as a
     line; with any other number as a hub node (a Cross Connect is one
     shared L2 segment, not point-to-point links). Cross Connects without
     visible peers get their own box. Double-click or "Open diagram" drills in.
     ELK lays out each location on its own, so lines between locations
     (VPN tunnels, manual links, lines to a Cross Connect hub whose peers
     sit in several locations, lines to the "Outside the contract" group)
     would have no route. The contract diagram therefore sets
     `linkedLayout`: `layoutDiagram` puts the top-level boxes such lines
     join (`linkedBoxes`) into an invisible box that ELK lays out as one
     layered graph (`INCLUDE_CHILDREN`), so those lines are routed around
     the cards as well; lines between groups are given to ELK from the
     earlier group to the later one (and turned back afterwards), so they
     do not loop round. Locations no line joins keep their own layout.
  2. **Datacenter**: internet on top, LANs as bars, resources between them,
     tiered by distance from the internet (the LAN a resource reaches first
     is drawn above it, the others below). Servers sharing a name stem and
     the same LANs collapse into one packed group with a single link per LAN.
     A group of more than `GROUP_LIMIT` (8) members, server group or
     leftover group, is drawn collapsed: the first `GROUP_PREVIEW` (6) by
     name and a member-sized "+N more" box (type `more`) that expands it; an
     expanded group has a "Collapse" button in its header. Members that
     matter are always shown and take room from the preview, so the group
     keeps its size: the selection (for a NIC or volume, its server),
     network appliances, and what is new or changed in a comparison. Hidden
     members, their NICs and volumes are anchored to the "more" box (load
     balancer targets in it get one on-demand line there); search hits
     among them are counted on it ("+6 more · 3 matches"), but never change
     the layout. The header keeps the full count.
     Load balancer targets show only while the balancer or a target is
     selected. A server (or server group) in `ROUTER_LANS` (4, the same
     number that flags an appliance) or more LANs is a *router* box with a
     "N LANs" line. A non-public LAN with nothing on it but that one router
     box is folded into it: a *stub* LAN (no Cross Connect) gets no box and
     is counted as "+N LANs only here" on the router (a click unfolds the
     router: its stub and transit LANs come back as boxes, "fold LANs
     again" folds them); a *transit* LAN (only Cross
     Connects besides the router) gets no box either, and the router's line
     goes straight to the Cross Connect, labelled with the LAN name. Their
     anchors point to the router box (stub) or to that line (transit), so
     search and selection still find them; a manual link to a folded LAN
     starts at the router. Of the remaining LANs, the router always draws
     the line to its first one and to LANs nothing else connects (of two
     routers sharing such a LAN, the first; a LAN between two routers is
     never folded); its other LAN lines are on demand, drawn while the
     router or that LAN is selected, and those LANs carry a "via router"
     marker. LAN tiers still count every membership. Cross Connects lead to peer
     datacenter nodes that open their diagram. Unattached volumes and
     unknown resources get boxes of their own.

  On-demand lines (load balancer targets, router LANs) are not given to
  ELK, so they do not shape the layout and selecting does not lay a view
  out again; like lines across group borders in a datacenter view they are
  drawn as curves, from the top of a box when the other end lies above it.

  Every model node has an *anchor* (the box or line that shows it: a NIC or
  volume → its server, everything in a datacenter → its card on the contract
  view), so search hits light up and selections from search, links or the URL
  move the diagram there. Layout of a 240-datacenter contract takes under a
  second (see `scale.test.ts`).

  What the user opened (expanded groups, unfolded routers: `lans:<box>`)
  lives in the canvas per view and goes into `datacenterDiagram` as
  `options.expanded`, together with the selection (`options.selected`);
  both only add or swap boxes, so they reach the layout through the
  signature below. Opening or closing a box keeps it in view once laid out.
  It is kept in `localStorage` per contract (`opened.ts`,
  `ionos-explorer:opened:<contract>`, the 100 views used last), so a
  reload or another tab shows the same. "Expand all" and "Collapse all"
  (Layers menu) open every collapsed group and folded router of the view
  (`expandable`: the groups with a "+N more" box and the routers with
  folded LANs) or close them all.

  Layouts are cached by a *layout signature* (`layoutSignature` in
  `layout.ts`: node ids, types, parents, sizes, ELK options and the edges ELK
  routes), the 30 most recently used kept. A model rebuilt for annotations
  or a comparison reuses them: new titles, change markers and links ELK
  does not route are put on the cached positions (`withData`). Only a new
  box or a new link between siblings (on the contract view: any new line)
  lays a view out again. Each view is
  fitted when it opens and again when the canvas changes size, unless the
  user has panned or zoomed since. The legend sits in the bar while it fits
  on one line, otherwise behind a "Legend" button.

  *Detail by zoom* (`lod.ts`): the zoom sets one of three classes on the
  canvas, `lod-near` (≥ 0.6, everything), `lod-mid` (0.3–0.6: titles,
  appliance tags, pills on datacenter cards, "N LANs" on routers and the
  labels of Cross Connect, tunnel and manual-link lines; no subtitles, IPs,
  "via" markers or buttons) and `lod-far` (< 0.3: titles only, larger and
  centred; group titles, change bars and the "+2 ~5 −1" pill of a card
  stay, change and router bars get thicker). The rest is CSS, so zooming
  never re-renders the boxes or lays the view out again; only a change of
  level renders the canvas once. While the user zooms, a level holds 10 %
  past its threshold (`lodFor(zoom, previous)`), so it does not flicker; a
  view the canvas framed itself gets the plain level of its zoom, so a
  fitted view always looks the same. Boxes marked `full` (selected, next to
  the selection, search hits) and the box with keyboard focus keep all their
  detail; buttons in other boxes are hidden from sight only, so Tab still
  reaches them and shows them.

  *Layers* (`layers.ts`, the "Layers" button in the bar, `LayersMenu.tsx`):
  switches for load balancers (with their target lines), NAT and VPN
  gateways (with the tunnels drawn from them), managed services (node
  pools, databases, Kafka, NFS), VPN tunnels and manual links, the leftover groups
  (Security Groups, unattached volumes, other resources) and Cross Connect
  peers. A hidden layer goes into the diagram options (`options.hidden`)
  and is left out when the diagram is built, so it is part of the layout
  signature and the layout uses the room; LAN tiers and folded LANs are
  still worked out with the hidden resources, so the rest keeps its shape.
  The internet, peer datacenters and endpoints outside that were there only
  for removed lines go with them. The contract view honours only "VPN
  tunnels and manual links" (with the "Outside the contract" group); the
  menu greys out the others there. Two emphasis modes, "Only appliances"
  and "Only changes" (with a comparison loaded), dim everything else in
  `toFlow` like a search does, without a new layout. The choice is kept per
  browser and contract in `localStorage` (`ionos-explorer:layers:<contract>`;
  the key without a contract, from earlier versions, is read when a
  contract has none) and is part of the link: `hide=lb,managed` and
  `emphasis=appliances` in the hash, written on every change (replacing the
  history entry), read first, so a shared link shows what its sender saw
  and back and forward restore it. A changed layer reframes a view the
  canvas had framed. A selection that a hidden layer
  keeps off the canvas (picked in search) gets a note at the top of the
  canvas, "fra-core-nlb is hidden by Layers: Load balancers", with a
  "Show" button that turns that layer on again (`hiddenBy` builds the view
  with each hidden layer shown in turn). The legend lists only the line
  kinds the current diagram draws.

  *Focus and path views* (`src/model/paths.ts`, `focusDiagram` and
  `pathDiagram` in `build.ts`): what a resource is connected to, and how one
  reaches another, across datacenters. Both work on the *network graph* of
  the applied model (so manual links and sites count): servers, LANs, Cross
  Connects, NAT and VPN gateways, load balancers, node pools, the managed
  databases, Kafka and NFS, and endpoints outside the contract; edges from `member`, `cross-connect`,
  `gateway`, `connection`, `listener`, `target-lan`, `target` (an ALB's
  target group skipped), `tunnel` (from the VPN gateway) and `manual`,
  undirected. NICs, volumes and tunnels stand for their server or gateway
  (`networkNode`). `neighbourhood(model, id, hops)` is a breadth-first
  search where every node counts as a hop (from a server: 1 its LANs, 2
  what else is on them and their Cross Connects). `findPaths` returns up to
  three shortest paths without a node twice: Dijkstra, then Yen's algorithm
  (with Lawler's rule). In the middle of a path only LANs, Cross Connects,
  VPN gateways, endpoints outside, load balancers (in from the listener LAN,
  out to a target) and servers may stand; a server that is no detected
  appliance costs `PLAIN_SERVER_COST` (1000) hops, so a route through
  appliances always wins and plain multi-homed servers are a last resort
  (listed in `plain`). Twins (same kind, appliance or not, same neighbours:
  an HA pair, a web farm) are searched through once; other nodes that join
  the same two neighbours at the same cost are a path's `alternatives`, so
  a route via fw-01 or fw-02 is one route. A path with a shortcut (two inner
  nodes are neighbours) is not shown. `describePath` puts each step in
  words ("member of LAN app", "Cross Connect fra-backbone to
  fra-prod-data", "routed by fra-core-fw-01 (likely firewall or VPN
  gateway), or fra-core-fw-02"). Results are cached per model.

  The modes live in the hash (`src/ui/mode.ts`): `focus=<id>` or
  `path=<from>,<to>`, with `hops=1|3` (2 is the default); `dc` stays, so
  the breadcrumbs ("All datacenters › fra-prod-core › Focus: fra-core-fw-01
  ✕"), ✕ and the browser's back button return to the view below. The
  details panel of any network resource has "Focus" and "Path to…" (a
  search picker shared with the manual-link form). `focusDiagram` cuts the
  model down to the neighbourhood and draws each datacenter in it with
  `datacenterDiagram` (tiers, routers, folded LANs, collapsed groups,
  layers, selection all apply) as a group; Cross Connects sit between the
  groups and lead to peer datacenters out of reach, endpoints outside and
  the tunnels and links in reach are drawn too. A LAN with something out of
  reach on it is not folded into its router (`DiagramOptions.pinned`, which
  also keeps the focus out of a "+N more" box). Boxes are ordered from the
  focus outwards (its datacenter, Cross Connects, the datacenters behind
  them, peers) so the linked layout reads from the focus down. The focus is
  marked (`NodeData.focus`, an outline) and keeps its detail at every zoom;
  a new focus or path view is fitted whole. `pathDiagram` merges the paths
  into one graph (a box per resource, alternatives beside each step),
  grouped by datacenter with Cross Connects and endpoints between, laid out
  left to right, or top to bottom when the free canvas is taller than wide
  (the details drawer is always open in a path view); it is `directed`, so
  the linked layout keeps lines pointing from start to end. Layers do not
  apply to a path (the menu greys them out); emphasis, search dimming and
  comparison markers do. The drawer shows the steps of each route
  (`PathPanel`); with several, "Show" lights one up (`route=<n>` in the
  hash, not part of the view's key): its nodes are the emphasis, and a
  line stays bright only if both its ends are (`toFlow`'s `strict`), since
  the routes share their ends. "Copy as text" puts all routes on the
  clipboard (`pathsText`: one line per resource, the step below it). With no route, the canvas shows both neighbourhoods side by
  side and the panel says that tunnels or routes inside VMs can be added as
  manual links. A resource picked in search that a focus or path view does
  not contain gets a note with "Show in its diagram".

  *Own positions* (`positions.ts`): in every view the user can drag
  top-level boxes and groups, and the boxes in a group
  ELK lays out as a graph (datacenter cards and hubs in a location); not
  the members of a packed group or its "+N more" box (`movable`). A drop
  stores an offset from the automatic place, per view (the diagram key:
  `contract`, `dc:<id>`, `focus:…` or `path:…`, so a focus or path view
  keeps its own, apart from the datacenter views whose box ids it shares)
  and diagram node id, in the annotations
  (`positions`), so a layout with new resources keeps the intention.
  Offsets are applied to the finished layout (`applyPositions`, after
  `withData`), so they are no part of the layout signature: dragging never
  lays a view out again, and the model is not rebuilt either (`App` leaves
  positions out of `applyAnnotations`). A moved box takes its contents
  along; a group with a moved box inside is drawn around its contents (it
  grows or shrinks, its padding stays). Routed lines whose ends moved apart
  lose their points (`moved`) and are drawn as right-angled steps between
  the sides that face each other (`handles` in `flow.ts`); lines whose two
  ends moved together keep their route, shifted. Offsets for boxes a view
  no longer has (a collapsed group, a folded LAN, a hidden layer, a
  resource gone from the snapshot) or may not move (a server that joined a
  group) are kept and ignored. While dragging, the offset lives in the
  canvas and follows every pointer move; the drop (and each arrow key on
  the selected, focused box, 5 px or 20 px with Shift) writes it to the
  annotations. A drag never selects (`selectNodesOnDrag` off) and a click
  may shake by 4 px; only the box held moves, not the selected one along
  with it, unless several boxes were picked (Shift and drag draws a
  selection rectangle, Ctrl/Cmd and click adds one): then the picked
  boxes move together (`movingWith`; a box inside a picked group goes
  with the group), stored in one change. With "Snap moved boxes to the
  grid" (Layers menu, kept per browser) a dropped box's top left corner
  lands on the background's 20 px dots (`snapToGrid`). On a touch screen (`(pointer: coarse)`) a finger on a box pans
  the canvas as before and only the selected box can be dragged. "Reset
  layout" in the bar (while the view has stored positions) forgets them,
  with "Undo reset" until the next move; the Overview's "Box positions"
  resets all views. Search, selection framing, the minimap and comparisons
  use the moved positions.

  *Export* (`export.ts`, the "Export" button in the bar,
  `ExportMenu.tsx`): the current view (contract, datacenter, focus or
  path) as SVG, PNG, PDF or draw.io file, built from the layout the canvas
  draws (own positions applied) and the node data, not from the DOM. So
  it is independent of zoom, level of detail (always full detail), colour
  scheme and CSS: hidden layers, collapsed groups, folded LANs, moved
  boxes and their dropped routes come out as on screen; the selection,
  search and emphasis dimming and lines shown only on selection do not;
  comparison markers do (with "Changed since …" in the legend). The SVG
  is a standalone file: attributes only, the light colour tokens copied
  from `index.css` (a test keeps them in step), Arial-compatible fonts
  with fixed sizes, text widths estimated from Arial's glyph widths so
  long names are cut with "…" like on the canvas, every text XML-escaped
  (characters XML forbids become U+FFFD), a footer with the view's title,
  contract, snapshot time and legend. PNG: that SVG drawn from a `blob:`
  image onto a canvas at 1×, 2× or 4× (less beyond 50 Mpx), optionally
  without the background rectangle (transparent); the choice is kept per
  browser. PDF (`pdf.ts`, no library): the same picture at 2× (at most 30
  Mpx a page), its RGB pixels Flate-compressed (fflate) into an image per
  page, the page the picture's size in points (at most Acrobat's 200
  inches), title in the document info; nothing else (no fonts, scripts or
  links). draw.io: an
  uncompressed `mxfile` with one vertex per box (groups as containers),
  one edge per line (ELK's bend points as waypoints, in the coordinates of
  the innermost group holding both ends), and the title and legend on a
  second layer. Files are named `ionos-<contract>-<view>-<snapshot
  date>.<ext>` (only `A–Z a–z 0–9 . _ -`) and saved with `a[download]` on a
  `blob:` URL; nothing is uploaded. "All views" lays out the contract view
  and every datacenter view with the current layers, opened groups and own
  positions (from the same layout cache as the canvas) and saves one PDF
  or draw.io file with a page per view, or the SVGs in a ZIP.

  Two layout rules came with these views and leave the earlier views as
  they were: in a linked box, a group no routed line enters (a packed server
  group; lines end at its box) keeps its own algorithm; and lines between
  two top-level boxes join them into a linked box, since the packing root
  routes nothing.

  React Flow, the ELK
  client and the canvas are a chunk of their own, fetched when the user
  starts opening a snapshot (first click, key or drag on the open screen);
  the 1.6 MB ELK worker is fetched on the first layout.
- `src/ui`: open screen, search panel, detail panel (properties, connections, contents, raw JSON, "Focus" and "Path to…"), the path steps (`PathPanel`), contract overview with the visibility report. Selection, query and the focus or path view live in the URL hash.

### Connectivity the API cannot see

Site-to-site links built *inside* VMs (e.g. Cisco Catalyst 8000V / CSR1000v
or ASAv doing IPsec) are invisible to the IONOS API: it only sees a VM with
NICs. The explorer handles this in three layers:

1. **Appliance detection (heuristic, `src/model/appliances.ts`).** A server
   is flagged as a network appliance, always with the reasons, from these
   signals: an attached volume's or CD-ROM's image name matching a product
   rule (`IMAGE_RULES`: Cisco Catalyst 8000V/CSR/ASAv/FTDv/SD-WAN, FortiGate,
   Palo Alto, Check Point, vSRX, Sophos, BIG-IP, VeloCloud, VyOS, pfSense,
   OPNsense, MikroTik, OpenWrt); a managed VPN tunnel ending at its public
   IP; firewall rules admitting IKE (UDP 500/4500), ESP or AH; NICs in a
   public and a private LAN (or in three or more LANs); a shared failover
   IP; name or label words (`NAME_HINTS`). Product or tunnel → *certain*;
   IPsec rules plus routing position → *likely*; routing position plus a
   weaker hint → *possible*. Ordinary multi-homed servers (bastions, proxies)
   are not flagged. Appliances get a tag in the diagram, a pill on their
   datacenter card, an Overview list and `is:appliance` in search. Both
   rule lists are plain data, meant to be extended.
2. **IONOS VPN Gateway (managed).** The exporter fetches IPsec and WireGuard
   gateways with their tunnels / peers from the regional VPN API in every
   region. A gateway hangs between the internet and the LANs it connects. A
   tunnel whose remote host is a public IP of the contract (server NIC,
   failover IP, NAT, load balancer, another VPN gateway) is drawn to that
   resource; otherwise to an external endpoint node. Pre-shared keys are
   never returned by the API.
3. **Manual links and sites (`src/annotations`).** Links the user adds in a
   resource's details (e.g. `fra-core-vpn-01 ↔ txl-core-vpn-01, IPsec`), and
   external sites such as "Head office" with optional public IPs; VPN
   tunnels to those IPs then end at the site. Kept per contract in the
   browser's local storage and exported/imported as a JSON file
   (`format: "ionos-explorer-annotations"`, keyed by resource ID), never in
   the snapshot. Links to resources missing from a snapshot are kept and
   reported. Drawn dotted orange; VPN tunnels dashed magenta. The same
   file carries the boxes the user moved (`positions: [{view, node, dx,
   dy}]`, merged by view and box like links by id).
4. **IP corrections (same file, `ips: [{nic, ips, note}]`).** IONOS only
   knows the IP it has on record for a NIC; with DHCP off it never hands it
   out and the VM may use another. The model keeps NICs' `dhcp` flag
   (search `dhcp:off`), and a correction replaces the NIC's and server's
   IPs in the applied model (search, details, diagram ✎) while the IONOS
   ones stay in `ionosIps` (`is:corrected`; `ip:` finds both). Entered per
   NIC in the details, or pasted on the Overview page as lines of
   `server, LAN, IP`, `MAC, IP` or `NIC id, IP` (`annotations/ipList.ts`).
   Corrections are keyed by NIC ID, so they survive re-exports. Other
   resolution (load balancer targets, VPN remote hosts) still uses the
   IONOS IPs.

On the contract view, tunnels and links between datacenters are one line
per datacenter pair (labelled with the name, or a count), endpoints outside
the contract sit in their own group. In a datacenter view the far end is
drawn above the local one: a peer datacenter node or an external endpoint.

Snapshot sizes are small (a few MB for hundreds of servers), so everything
runs in the browser.

### Comparing snapshots (`src/diff`)

Two snapshots of the same contract are compared resource by resource,
matched by ID (a rename is a change, not a removal and an addition). What
is compared is what the explorer shows: name, state, parent, IONOS IPs,
labels, properties (facts) and outgoing connections. Timestamps, the
datacenter version counter and derived counts are left out, and so are
edge labels (IP changes are reported as such). Annotations are applied
after comparing, so links and IP corrections never show up as changes.

The open snapshot is always the newer one; choosing a newer file to
compare with swaps the two. The Changes tab lists changes by datacenter
with before → after per field; added and changed resources are marked in
the diagram (bar on the box, "+2 ~5 −1" on datacenter cards), in the
details panel and in search (`is:added`, `is:changed`). Removed resources
only exist in the Changes list.

`ionos-fixture -previous` writes the demo contract as it was two weeks
earlier (`internal/fixture/history.go`): built the same way, then a few
edits rolled back, so every ID matches and a test checks that only those
edits differ.

## Security notes

- Snapshots contain IPs, firewall rules, names and (for admin exports) user
  emails. Treat them as confidential. Encrypt with `age` when they leave the
  machine that exported them. The root `.gitignore` refuses `*.ionx` and
  `*.age` except the synthetic fixture.
- The exporter never writes the token, the `Authorization` header, or
  request bodies anywhere, and blanks password-like fields in responses
  (see SNAPSHOT_FORMAT.md) in case an API returns one. Should an API's
  error message echo the credentials, `httpx` replaces them with
  `[credentials removed]` before the message goes anywhere (coverage,
  screen, log).
- The explorer in the browser only ever talks to the server it came from
  (CSP `connect-src 'self'`); a static build has no backend at all. A
  malicious snapshot can at worst render odd text: values are always
  rendered as text, never as HTML.

### ionos-explorer (the local server)

The server holds an IONOS token and confidential data and has no TLS, so
it trusts nobody else: not other websites the browser has open, not other
users of the machine, not names that resolve to 127.0.0.1. Each measure is
tested in `exporter/internal/server/server_test.go` (named in brackets).

- **Loopback only.** `--listen` must be `127.0.0.1`/another loopback IP,
  `::1` or `localhost`; anything else is refused at start
  (`TestListenAddresses`, and the command's `TestRefusesWhatItShouldNot`).
  Serving others is hosted mode, with its own rules (below).
- **Login secret, cookie and session key** (`TestLogin`,
  `TestPageNeedsLogin`, `TestAPINeedsCookieAndKey`). Three values from
  `crypto/rand` (32 bytes each), new every run, compared in constant time:
  the *login secret* in the printed URL; `GET /login?secret=…` sets the
  *session cookie* `ionos-explorer-<port>` (HttpOnly, SameSite=Strict,
  Path=/) and answers with a page that moves on to `/#session=<key>` by
  itself (a redirect at the end of a navigation that started elsewhere,
  e.g. the launcher file, would not carry a Strict cookie). The page moves
  the *session key* from the fragment into `sessionStorage` and out of the
  address bar. Every page and file needs the cookie (Jupyter's model);
  every API call needs the cookie and the key in `X-Ionos-Explorer`. Why
  both: browsers send cookies for 127.0.0.1 to every port, so a page of
  another local user's server on another port, opened in the same
  browser, would receive the cookie; `sessionStorage` belongs to this
  origin (port included), and the key is never in a response a cookie
  alone can get. A key in the URL query instead of the header is not
  accepted. The login secret stays valid for the run (a second browser can
  log in with it).
- **Host check** (`TestHostCheck`): the `Host` header must be
  `127.0.0.1:<port>` (or `[::1]:<port>`) or `localhost:<port>`, otherwise
  421. A DNS-rebinding site (a name that resolves to 127.0.0.1) gets
  nothing, not even the login.
- **Origin and request shape** (`TestRequestChecks`): POSTs need
  `Origin: http://<host>` (a missing, `null` or other origin is refused),
  `Content-Type: application/json` (so no cross-site form or "simple"
  request gets through), and at most 64 KiB of body; API calls with
  `Sec-Fetch-Site` other than `same-origin` are refused (navigations
  included). Unknown fields, malformed tokens (spaces or control
  characters), skip patterns other than paths/ids and non-numeric
  contract numbers are refused before anything reaches IONOS.
- **No CORS** (`TestSecurityHeaders`): no `Access-Control-*` header on any
  response; `OPTIONS` gets 405.
- **Headers** (`TestSecurityHeaders`, `TestCSPMatchesTheBuild`): every
  response carries the build's CSP (the same string as
  `explorer/vite.config.ts`; a test compares them) plus `frame-ancestors
  'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy` and
  `Cross-Origin-Resource-Policy: same-origin`; API and login answers
  `Cache-Control: no-store`.
- **The token** (`TestTokenNeverLeaks`, `TestWrongToken`,
  `TestForgetZeroesTheToken`, `TestIdleForget`): it only arrives in a POST
  body (which is overwritten once handled) and is never logged, put in a
  URL, an error message, a response or the snapshot: the tests send a
  token, make the fake API echo it in error bodies, and search every
  response, the log and the snapshot for it. It is held as a byte slice,
  overwritten and dropped on Forget, on exit, on a 401 from IONOS, after
  `--forget-after` unused, and after the fetch when "keep" is off. Limit:
  Go strings cannot be overwritten, so the copies `net/http` needs for the
  `Authorization` header (and the decoded JSON string) stay in memory
  until the garbage collector reuses it.
- **IONOS stays read-only**: the crawl uses `internal/httpx` as
  `ionos-export` does (GET/HEAD only, listed hosts only, https except to
  loopback, no redirects, no bodies); snapshot redaction is unchanged.
- **One fetch at a time** (`TestOneFetchAtATimeAndCancel`); Cancel and
  Forget stop a running one. Server timeouts are set (headers 10 s, body
  30 s, responses 2 min).
- **Memory only** (`TestMemoryOnly`): the server writes no file; the test
  runs a fetch with an empty working directory, `TMPDIR`, `HOME` and
  `XDG_CACHE_HOME` and checks they stay empty. The result is handed over
  once and dropped (`TestFetch`); the page keeps it in memory until
  Download. The one file the program writes is the `--open` launcher
  below.
- **Opening the browser** (`TestOpensTheBrowserWithoutTheSecretOnACommandLine`):
  a command line is visible to other users of the machine, so `--open`
  does not pass the login URL to `xdg-open`/`open`. It writes a page that
  forwards to it (mode 0600, in a fresh 0700 temp folder) and opens that
  file; the folder is removed two seconds after the first login, and on
  exit. The URL is also printed, to the user's own terminal. Sandboxed
  browsers that cannot read the temp folder (some snap packages) show an
  error; the printed link works.
- Diagram exports (SVG, PNG, PDF, draw.io, ZIP) are made in the browser and handed
  to the browser's downloads through a `blob:` URL; the PNG is drawn from
  a `blob:` image, which the CSP's `img-src 'self' data: blob:` allows.
  Names in exported files are escaped (also as HTML inside draw.io
  labels), and the files reference nothing outside themselves. They
  contain names, IPs and descriptions from the snapshot: as confidential
  as the snapshot, but without resource UUIDs (only what the boxes show,
  such as LAN numbers).

### Hosted mode

Everything above holds per session, with these differences (tested in
`exporter/internal/server/hosted_test.go` and the command's `TestHosted*`):

- **Any listen address**, plain HTTP: TLS is the proxy's job. The public
  URL decides the rest (`TestPublicURL`, `TestHostedConfig`): https only
  (http for localhost), no user, query or fragment, a path of plain
  segments. No hosted mode without a login method.
- **Host and Origin** (`TestHostedHostAndOrigin`): `Host` must be the
  public URL's host (421 otherwise, also for the login); POSTs need its
  origin. `X-Forwarded-*` headers are not used for anything, so the proxy
  must pass the original `Host`.
- **HSTS** (`TestHostedCookie`): with an https public URL every answer
  carries `Strict-Transport-Security: max-age=31536000` (no
  `includeSubDomains`: other hosts under the domain are not ours to pin).
- **Cookie** (`TestHostedCookie`): `__Host-ionos-explorer` (Path=/), or
  `__Secure-ionos-explorer` with the base path as Path under a sub-path,
  `Secure` over https; HttpOnly; SameSite=Lax, because Strict would drop
  it on the redirect back from an identity provider. Cross-site requests
  still need the key header and pass the Origin and `Sec-Fetch-Site`
  checks.
- **Separate sessions** (`TestHostedSessionsAreSeparate`): a session sees
  only its own status, token and result; one session's cookie with
  another's key is refused. Logging in again replaces the browser's
  session, logout ends exactly one (`TestHostedLoginRotatesAndLogoutEnds`).
- **The key in the page**: `index.html` carries it and is served
  `no-store`, only with the session cookie. Another site cannot read the
  page (no CORS, `X-Frame-Options: DENY`).
- **Expiry and limits** (`TestHostedSessionExpiry`,
  `TestHostedResultNotTaken`, `TestHostedFetchLimit`), see above.
- **Logs** (`TestHostedLogLines`, `TestJSONLog`): no token, cookie or
  key; user names cannot break a line; JSON lines are objects with time,
  level and message.
- **Probes** (`health_test.go`): any Host, no session needed, nothing else
  reachable that way; no path or error text in the answer; a broken users
  file, a read-only data directory, and no login provider working (with
  no local users) make `/readyz` 503 and are logged once; one working
  provider or local users are enough.
- **Local users** (`internal/users/users_test.go`, `local_test.go`, the
  command's `users_test.go`): argon2id round trip and parameter upgrade;
  the password rules; the same answer and time for unknown users
  (`TestLoginTakesAsLongForUnknownUsers`); the delays with a fake clock;
  the hash limit; the file (mode, atomic writes, two processes at once, a
  broken file kept); one-time links (single use, expiry, replaced by a
  newer one, only hashes stored); the last admin; login requests with
  the request checks; sessions ended by a password change, reset,
  disable, delete or a change made by the command; must-change; only
  admins manage users, never their own account; no password, link code
  or hash in logs or answers.
- **Snapshot history** (`internal/history/history_test.go`, the server's
  `history_test.go`, the command's `history_test.go`): files are age
  ciphertext, 0600 in 0700 folders, with no user name in any path; a
  user cannot list, read or delete another's snapshots, also with crafted
  IDs (`../`, encoded, absolute, another scope's) — always 404, never a
  path; cross-site and cross-origin requests refused as for every call;
  retention over a year and a half of synthetic times; quota eviction and
  refusal (the fetch is still handed out); key rotation with `rekey`; a
  crash between writing and renaming; deleting a user deletes their
  history; key file errors never quote the key.
- **Second factor** (`internal/users/totp_test.go`, the server's
  `totp_test.go`): the RFC 6238 vectors; ±1 step and no more; a code and
  a recovery code work once; failures keep counting across right
  passwords; the secret and recovery codes never in `users.json` in
  clear, nor in the log; enabling ends the other sessions; tickets used
  up, expired or made up are refused; `required` blocks everything but
  setting it up; an admin's reset ends the sessions; `required` without
  a key refuses to start; rekey.
- **OIDC providers** (`internal/oidc/oidc_test.go` against an in-process
  identity provider, `TestHostedSeveralMethods`, the command's
  `TestHostedOIDCProviderDown`): see "OIDC providers" above for the list
  of refused logins; the attempt cookie is sealed and bound to its
  provider's callback path; no ID token in the log; each provider's
  routes reach only it, overlapping routes refuse to start; unknown
  `IONOS_EXPLORER_OIDC_…` variables refuse to start; the client secret
  is not logged.

## Open-source readiness (before publishing)

- License: AGPL-3.0-only (`LICENSE`, decided 2026-10-15). Third-party
  licenses are listed in `NOTICE`: elkjs is "EPL-2.0 OR GPL-3.0-or-later"
  and used under the GPL (shipped unmodified as a separate worker file), the
  rest of the bundle and the Go modules are MIT/BSD. New dependencies must
  be AGPL-compatible (no EPL-only, no proprietary).
- Name: "IONOS" is a trademark. Prefer a neutral name with a "not affiliated
  with IONOS" note, or ask IONOS for permission.
- Go module path: `github.com/K4ugummi/ionos-explorer/exporter`; a
  release tags the module as `exporter/v1.2.3` too, for `go install`.
- History hygiene: no real snapshots, tokens, or company-specific names in
  any commit (`.gitignore` already refuses `*.ionx`/`*.age`).
- `CONTRIBUTING.md`, `SECURITY.md` (how to report issues; what the program
  can access; how to verify a release), issue templates that warn against
  pasting real data.
- On GitHub, by the owner: branch protection for `main` with the `ci`
  jobs required, private vulnerability reporting switched on.

### CI and releases (`.github/`)

Each workflow step calls a Makefile target or a script in `scripts/` or
`e2e/`, so whatever CI checks also runs locally. Actions are pinned by
commit SHA, tools by version (`go run pkg@version`), images by digest;
every job gets read access only, plus what it needs. Values from the event
reach `run:` steps as environment variables, never pasted into the script.

- **`ci.yaml`** (push to main, by hand; not on pull requests, to save
  runner minutes): `make test`, `test-race`, `vuln` (govulncheck with the module's toolchain, `npm audit --omit=dev`);
  `scripts/check-repo.sh` (no `*.ionx`, `*.age`, `*.token`, `.env` but the
  demo fixtures and `.env.example`), gitleaks over the whole history
  (false positives by fingerprint in `.gitleaksignore`), actionlint;
  `scripts/check-deploy.sh` (the Kustomize renders through kubeconform,
  `docker compose config` and `docker stack config`);
  `scripts/check-context.sh` (planted snapshots and credentials stay out of
  the build context), the image for amd64 and arm64, and
  `scripts/smoke-image.sh` on the amd64 one.
- **`e2e.yaml`** (push to main, weekly, by hand): `e2e/compose.sh` and `e2e/kind.sh`, the browser check
  of `e2e/hosted.mjs` (Playwright) against the dev setups with the fake
  API: first admin by the setup link, fetch, logout, restart, login,
  fetch. No request may go to another origin, no console error. Screenshots
  and logs are uploaded on failure.
- **`release.yaml`** (tags `v*`, semver): the tests again, without caches;
  the amd64 image scanned with grype (a fixable high or critical finding
  stops the release), then the image pushed to
  `ghcr.io/<owner>/ionos-explorer` for amd64 and arm64 (tags from the
  version, `latest` not for pre-releases) with an SBOM and provenance
  (`mode=max`), signed by digest with cosign keyless; the archives of
  `scripts/build-release.sh` with `SHA256SUMS`, signed as a sigstore
  bundle, in a **draft** release to publish by hand; the module tag.
- **Dependabot**: actions, Go modules, both npm projects, the Dockerfile's
  base images, Caddy in Compose; weekly, minor and patch grouped. The tools
  in the Makefile and scripts and the gitleaks image are updated by hand.

## Roadmap

1. ✅ Repo scaffold, snapshot format v1, manifest schema, fixture generator
2. ✅ Exporter MVP: Cloud API compute, network and Cross Connects, DBaaS PostgreSQL (v2, regional since the first real run); coverage; age
3. ✅ Explorer MVP: load snapshot (incl. age), global search, detail panel
4. ✅ Diagram: contract overview with Cross Connects, datacenter drill-down
5. ✅ Appliance detection, VPN Gateway coverage, manual links and sites
6. ✅ IP corrections, Security Groups, comparing snapshots
7. ✅ Canvas for real contracts: router
   boxes, collapsed groups, detail by zoom, layers, focus and path views,
   own positions, SVG/PNG/draw.io export
8. ✅ One binary, `ionos-explorer`: serves
   the UI on 127.0.0.1 and fetches itself, token typed into the page,
   data in memory until downloaded
9. Hosted for a team in a container:
   hosted mode with sessions, login with local users and OIDC providers, encrypted snapshot
   history on a volume, image, Compose and Kubernetes (tested), Helm,
   Swarm, Podman/systemd (provided), more platforms documented, CI and releases
10. ✅ Wider coverage: Cloud DNS (linked to resources by IP and name),
    MariaDB, MongoDB, In-Memory DB, Kafka, Network File Storage, Certificate
    Manager (expiry), CDN, Container Registry, Logging and Monitoring
    pipelines, VM Auto Scaling, backup units, volume snapshots. Not
    possible with a token: Object Storage buckets
