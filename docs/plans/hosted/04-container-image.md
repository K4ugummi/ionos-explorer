# 04 Container image

**Problem.** There is no image. The binary needs a UI build (Node) and a Go
build with `-tags embedui` (`make explorer-app`), and must run as a small,
non-root, read-only container.

## Design

- **Dockerfile** (repo root, multi-stage, BuildKit):

  ```dockerfile
  # syntax=docker/dockerfile:1.7
  FROM --platform=$BUILDPLATFORM node:24-alpine AS ui      # pin by digest in CI
  WORKDIR /src/explorer
  COPY explorer/package.json explorer/package-lock.json ./
  RUN --mount=type=cache,target=/root/.npm npm ci
  COPY explorer/ ./
  COPY fixtures/ /src/fixtures/       # the demo snapshot is bundled
  RUN npm run build

  FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS go  # pin by digest in CI
  ARG TARGETOS TARGETARCH VERSION=dev
  WORKDIR /src/exporter
  COPY exporter/go.mod exporter/go.sum ./
  RUN --mount=type=cache,target=/go/pkg/mod go mod download
  COPY exporter/ ./
  COPY --from=ui /src/explorer/dist ./internal/webui/dist
  RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
      CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
      go build -trimpath -tags embedui -ldflags "-s -w -X main.version=$VERSION" \
        -o /out/ionos-explorer ./cmd/ionos-explorer

  FROM gcr.io/distroless/static-debian12:nonroot          # pin by digest in CI
  COPY --from=go /out/ionos-explorer /usr/local/bin/ionos-explorer
  ENV IONOS_EXPLORER_MODE=hosted IONOS_EXPLORER_LISTEN=:8080 IONOS_EXPLORER_DATA_DIR=/data
  EXPOSE 8080
  VOLUME /data
  USER 65532:65532
  HEALTHCHECK --interval=30s --timeout=3s CMD ["/usr/local/bin/ionos-explorer", "healthcheck"]
  ENTRYPOINT ["/usr/local/bin/ionos-explorer"]
  ```

  Cross-compiled (`$BUILDPLATFORM`) so amd64 and arm64 build fast without
  emulation. `ionos-export` is added to the same image
  (`/usr/local/bin/ionos-export`), so `docker run … ionos-export` works for
  people who only want the CLI.
- **Any UID:** `/data` is created in the image owned by 65532:0 with
  mode 0770 (group 0 writable), so OpenShift's random UID with group 0
  works too; the program needs no home directory or passwd entry
  (tested by running the image with `--user 123456:0`).
- **Runtime image:** distroless static, non-root (65532), no shell, CA
  certificates included (needed for IONOS and the IdP). Expected size
  ~20 MB. Must work with a read-only root filesystem: the program writes
  only to `DATA_DIR` (temp files for atomic writes live there too).
- **`.dockerignore`:** everything but `explorer/`, `exporter/`,
  `fixtures/demo-*`, `schema/`; and explicitly `*.ionx`, `*.age`,
  `!fixtures/demo-contract*.ionx`, `**/node_modules`, `bin/`, `.git`,
  `.env*`, `*.token`, so a real snapshot in the repo root can never end up
  in a build context or image layer.
- **Health:** `GET /healthz` (process alive; no auth, no Host check, no
  data) and `GET /readyz` (data dir writable, OIDC discovery fetched at
  least once, not shutting down). Subcommand `ionos-explorer healthcheck`
  calls `/healthz` on the local listen port (distroless has no curl).
- **Shutdown:** on SIGTERM stop accepting, let running fetches end for up
  to 20 s (then cancel), zero all held tokens, exit. Kubernetes
  `terminationGracePeriodSeconds: 30`.
- **Logs:** to stdout, `LOG_FORMAT=json` for log collectors: login,
  logout, refused login, fetch start/end (user subject hash, contract,
  counts, duration, errors), history store/delete/retention. Never tokens,
  cookies, session keys, IdP codes or ID tokens (test greps for them).
- **Config from files:** every `*_FILE` variable reads the secret from a
  file (Docker/Kubernetes secrets); plain values in env still work.

## Tests

- `docker build` in CI for amd64 and arm64 (06); a smoke test runs the
  image read-only (`--read-only --cap-drop ALL --security-opt
  no-new-privileges`) in local mode published to 127.0.0.1, checks
  `/healthz`, and in hosted mode with the fake IdP and fake API checks a
  login and a fetch (CI job with Compose, see 05).
- `healthcheck` subcommand exit codes; `*_FILE` precedence and trimming;
  shutdown zeroes tokens and cancels fetches (Go test).
- Build context check: a dummy `ionos-test.ionx` in the repo root is not
  in the context (`docker build` with a step that lists files, CI only).

## Accept

- `docker build -t ionos-explorer .` works from a clean clone; image
  < 30 MB; `docker run --rm -p 127.0.0.1:8080:8080 -e
  IONOS_EXPLORER_MODE=local ionos-explorer` serves the local mode (with
  the login link in `docker logs`). For local mode in a container the
  loopback rule has to accept the container's own address: allowed only
  when the program detects it runs in a container *and* the operator
  passes `--local-in-container`, documented as "publish to 127.0.0.1
  only". (Decide in the package whether this is worth it; the user chose
  "team, hosted", so it may be dropped.)
