# Hosted for a team: plan

How to turn `ionos-explorer` (one binary, one user, loopback only; see
`docs/plans/merged-app.md`) into a container a team runs on a server, with
Docker Compose, Docker Swarm (stack) or Kubernetes. Each work package is its
own file, written so it can be picked up without any earlier conversation:
read this file, then the package.

## Decisions (user, 2026-10-15, verbatim answers)

- **Audience: team, hosted.** Runs on a server or in Kubernetes behind an
  ingress with TLS; several colleagues use it at the same time. Needs real
  login and separate sessions per user.
- **Login: built-in OIDC.** The app speaks OpenID Connect itself (client
  ID/secret in config); no extra proxy container.
- **IONOS token: each user types their own.** As today: held only in that
  user's session memory. Users only see what their own IONOS user may see.
  No shared IONOS credential on the server.
- **Data: volume with history.** Snapshots, age-encrypted with a key from a
  Secret, kept on a persistent volume with retention, so the Changes tab can
  compare with yesterday or last week and a restart loses nothing.

- **Hosting targets (2026-10-16):** "i will use docker and kubernetes for
  testing. as it is open source, we should prepare for more hosting
  solutions". So Docker (Compose) and Kubernetes are the tested paths, and
  the program and image follow rules that make other platforms work
  without code changes (see "Portability rules" and package 07).

The local single-user mode stays exactly as it is (default when no hosted
configuration is given), and so do `ionos-export` and opening `.ionx` files.

## Status

- [ ] [01 Hosted mode and sessions](01-hosted-mode-and-sessions.md): listen beyond loopback only with hosted config; state per session
- [ ] [02 OIDC login](02-oidc-login.md): code flow with PKCE, who may log in, logout
- [ ] [03 Snapshot history](03-snapshot-history.md): encrypted store on a volume, retention, history in the UI
- [ ] [04 Container image](04-container-image.md): Dockerfile, health checks, configuration by environment
- [ ] [05 Deployment](05-deployment.md): Compose, Swarm stack, Kubernetes (Kustomize)
- [ ] [06 CI and releases](06-ci-and-release.md): tests, image to GHCR, signed, scanned; module path
- [ ] [07 More hosting targets](07-more-hosting.md): Helm chart, Podman/systemd, OpenShift, cloud container services, S3 history

Order: 01 → 02 → 03 change the program and are each testable on their own
(02 needs 01's sessions, 03 needs 02's user identity). 04 can start in
parallel with 01 (the image works for the local mode too, published to
`127.0.0.1` only), 05 needs 04, 06 needs 04, 07 needs 05 and 06.

## Support levels

| Level | Targets | Meaning |
|---|---|---|
| Tested | Docker Compose; Kubernetes (kind in CI; any conformant cluster, e.g. IONOS Managed Kubernetes, by the maintainer) | Files in `deploy/`, end-to-end browser test in CI (05, 06) |
| Provided | Helm chart, Docker Swarm stack, Podman Quadlet / systemd, plain binary + systemd unit behind a reverse proxy | Files in `deploy/`, validated in CI (render, lint, schema), not run end to end |
| Documented | OpenShift, Nomad, AWS ECS/Fargate, Azure Container Apps, Google Cloud Run, other PaaS | Notes and constraints in `deploy/README.md`; community-maintained |

## Portability rules (every package)

What makes a new platform a matter of configuration, not code:

- **Configuration only by environment** (plus `*_FILE` for secrets); no
  config file required, no platform-specific code or detection.
- **One port** (`:8080`, configurable), plain HTTP; TLS always in front.
- **Behind any proxy and path:** `PUBLIC_URL` may contain a path
  (`https://tools.example.com/ionos-explorer`); the server and the UI work
  under that base path (assets, API, login callback). No reliance on
  `X-Forwarded-*`.
- **State only in `DATA_DIR`** (or, later, object storage: 07); the root
  filesystem can be read-only. Sessions and tokens in memory, so: exactly
  one instance, no scale to zero (a stopped instance logs everyone out),
  no request-based autoscaling.
- **Any user ID:** the image runs as 65532 by default and also as an
  arbitrary UID with group 0 (OpenShift): `/data` is group-0 writable,
  nothing depends on a home directory or a passwd entry.
- **Health** at `/healthz` and `/readyz`, logs to stdout (text or JSON),
  clean shutdown on SIGTERM within 20 s.
- **Egress:** HTTPS to the IONOS API hosts and the IdP only; a proxy via
  the standard `HTTPS_PROXY`/`NO_PROXY` variables (Go honours them).
- **Images** multi-arch (amd64, arm64), also published as a plain binary,
  so non-container platforms work.

## Target picture

```
             Internet / company network
                        │ HTTPS
              ┌─────────▼─────────┐
              │ Ingress / Traefik │  TLS (cert-manager, Let's Encrypt or company CA)
              └─────────┬─────────┘
                        │ HTTP, cluster-internal
┌───────────────────────▼────────────────────────────┐        ┌──────────────┐
│ ionos-explorer (1 replica, non-root, read-only fs) │───────►│ OIDC IdP     │ Entra ID, Keycloak,
│  /login → IdP, /callback, sessions in memory       │ HTTPS  │ (discovery,  │ Google, Authentik, …
│  per session: IONOS token (memory), fetch job      │        │  JWKS, token)│
│  history: /data (age-encrypted .ionx per user)     │        └──────────────┘
└───────────┬──────────────────────────┬─────────────┘        ┌──────────────┐
            │ PVC / volume /data       │ HTTPS, GET only ────►│ IONOS APIs   │
            ▼                          │                      └──────────────┘
      snapshots/<user>/<contract>/…    │
```

One replica: sessions and held tokens live in process memory, and the
volume is ReadWriteOnce. A restart logs everyone out and drops held tokens
(by design: tokens are never written anywhere); history survives on the
volume. Scaling out is a non-goal for now (see "Later").

## Configuration (all packages together)

Everything by environment variable (flags with the same meaning exist for
the binary). Secrets can also come from files (`*_FILE`, for Docker/K8s
secrets mounted as files), which is preferred over plain env.

| Variable | Package | Meaning |
|---|---|---|
| `IONOS_EXPLORER_MODE` | 01 | `local` (default) or `hosted` |
| `IONOS_EXPLORER_LISTEN` | 01 | default `127.0.0.1:0` local, `:8080` hosted |
| `IONOS_EXPLORER_PUBLIC_URL` | 01 | `https://explorer.example.com`; required hosted (redirect URI, Host check, cookie) |
| `IONOS_EXPLORER_MAX_FETCHES` | 01 | fetches running at once over all users (default 2) |
| `IONOS_EXPLORER_FORGET_AFTER` | 01 | held IONOS token dropped after unused (default 30m) |
| `IONOS_EXPLORER_SESSION_TTL` | 01 | session lifetime (default 12h, idle 2h) |
| `IONOS_EXPLORER_OIDC_ISSUER` | 02 | issuer URL (discovery at `/.well-known/openid-configuration`) |
| `IONOS_EXPLORER_OIDC_CLIENT_ID` | 02 | client ID |
| `IONOS_EXPLORER_OIDC_CLIENT_SECRET[_FILE]` | 02 | client secret (confidential client) |
| `IONOS_EXPLORER_OIDC_SCOPES` | 02 | default `openid profile email` (+ `groups` if needed) |
| `IONOS_EXPLORER_OIDC_ALLOWED_GROUPS` | 02 | comma list; empty = anyone the IdP authenticates for this client |
| `IONOS_EXPLORER_OIDC_ALLOWED_EMAILS` | 02 | comma list of addresses or `@domain` |
| `IONOS_EXPLORER_OIDC_GROUPS_CLAIM` | 02 | default `groups` (Entra ID: `groups` IDs or `roles`) |
| `IONOS_EXPLORER_DATA_DIR` | 03 | default `/data` hosted; empty = no history |
| `IONOS_EXPLORER_AGE_IDENTITY[_FILE]` | 03 | age X25519 identity (`AGE-SECRET-KEY-1…`) for the history |
| `IONOS_EXPLORER_KEEP` | 03 | retention, e.g. `daily=14,weekly=8,monthly=12` (default) |
| `IONOS_EXPLORER_MAX_USER_BYTES` | 03 | quota per user (default 500 MB) |
| `IONOS_EXPLORER_LOG_FORMAT` | 04 | `text` (default) or `json` |

Hosted mode refuses to start unless `PUBLIC_URL` (https, except
`http://localhost` for trials), the OIDC settings and (if `DATA_DIR` is
set) an age identity are present. No "hosted without login" switch.

## Open questions (defaults chosen, change any time)

1. **History private or shared?** Default **private per user and
   contract**: user B never sees a snapshot user A fetched, because A's
   IONOS user may see more than B's. Option for teams where everyone has
   the same IONOS read rights: `IONOS_EXPLORER_HISTORY=shared` (one history
   per contract; whoever can log in sees it). See 03.
2. **Annotations** (manual links, sites, IP corrections, box positions) stay
   in the browser for now (`localStorage`, export/import file). Storing
   them per user, or shared per contract, on the server fits naturally
   after 03 ("Later").
3. **Packaging for Kubernetes:** plain manifests with Kustomize (base +
   example overlay) in 05, and a Helm chart in 07 (expected by people who
   install open-source apps on Kubernetes).
4. **Registry:** `ghcr.io/k4ugummi/ionos-explorer` from GitHub Actions.

## Later (not in these packages)

- Several replicas: sessions in a shared store (Redis/Valkey) would mean
  IONOS tokens leaving process memory, which contradicts "held only in that
  user's session memory"; the alternative is sticky sessions plus a
  ReadWriteMany volume. Not needed for a team tool.
- Server-side annotations; scheduled fetches (would need a server-held
  token, which the user ruled out for now); audit log shipping.

## Rules for every package

Same as `docs/plans/canvas/README.md` ("Rules for every package"): privacy
(the real snapshot `ionos-*.ionx` in the repo root is never printed,
screenshotted or copied; counts only), no commits unless the user asks,
match the code style, `make test` passes, unit tests for every rule. Plus:

- **Never call the real IONOS API** in tests or checks: `internal/fakeapi`
  only. OIDC is tested against an in-process fake provider (package 02) and,
  for browser checks, a local IdP in a container (Dex or Keycloak, Compose
  profile `dev-idp`, never committed with real secrets).
- **Security first.** Every check in the hosted request path gets its own
  test (like `internal/server/server_test.go` does today). Write the
  security notes into `docs/ARCHITECTURE.md` ("Security").
- New Go dependencies only where hand-written code would be riskier (OIDC/JWT
  verification); each must be AGPL-compatible and listed in `NOTICE`.
