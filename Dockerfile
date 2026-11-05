# syntax=docker/dockerfile:1.7

# ionos-explorer for a team: the explorer UI embedded in one static Go
# binary, on a distroless base (no shell, no package manager), as a
# non-root user. Hosted mode by default; see deploy/README.md.
#
#   docker build -t ionos-explorer .       (or: make image)
#
# Both build stages run on the build machine and cross-compile, so an
# arm64 image builds without emulation:
#
#   docker buildx build --platform linux/amd64,linux/arm64 .
#
# The base images are pinned by digest (Dependabot keeps them current);
# change tag and digest together.


# The explorer's production build. The demo snapshots in fixtures/ are
# bundled into it.
FROM --platform=$BUILDPLATFORM node:24.12.0-alpine3.22@sha256:4f4a059445c5a6ef2b9d169d9afde176301263178141fc05ba657dab1c84f9a7 AS ui
WORKDIR /src/explorer
COPY explorer/package.json explorer/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY explorer/ ./
COPY fixtures/ /src/fixtures/
RUN npm run build

# The Go sources and modules, shared by the builds below.
FROM --platform=$BUILDPLATFORM golang:1.27.2-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS gosrc
WORKDIR /src/exporter
COPY exporter/go.mod exporter/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY exporter/ ./
ENV CGO_ENABLED=0 GOFLAGS=-buildvcs=false

# ionos-explorer with the UI embedded, and the ionos-export command line.
FROM gosrc AS go
ARG TARGETOS TARGETARCH
ARG VERSION=dev
COPY --from=ui /src/explorer/dist ./internal/webui/dist
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -tags embedui -ldflags "-s -w -X main.version=$VERSION" \
      -o /out/bin/ionos-explorer ./cmd/ionos-explorer && \
    GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags "-s -w -X main.version=$VERSION" \
      -o /out/bin/ionos-export ./cmd/ionos-export && \
    mkdir -p /out/root && mkdir -m 0770 /out/root/data

# The fake IONOS API with the synthetic demo contract, for trials and CI
# (deploy/compose/compose.dev.yaml, deploy/kubernetes/overlays/dev):
#   docker build --target fakeapi -t ionos-fakeapi .
# Never part of the release image.
FROM gosrc AS fakeapi-build
ARG TARGETOS TARGETARCH
ARG VERSION=dev
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags "-s -w -X main.version=$VERSION" \
      -o /out/ionos-fakeapi ./cmd/ionos-fakeapi

FROM gcr.io/distroless/static-debian13:nonroot@sha256:d62067879de890a1def9da0e7766b7d20810a5e5555cef8506b752437d7a3e88 AS fakeapi
COPY --from=fakeapi-build /out/ionos-fakeapi /usr/local/bin/ionos-fakeapi
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/ionos-fakeapi"]

# The release image (the default target, so it stays the last stage).
FROM gcr.io/distroless/static-debian13:nonroot@sha256:d62067879de890a1def9da0e7766b7d20810a5e5555cef8506b752437d7a3e88
ARG VERSION=dev
COPY --from=go /out/bin/ /usr/local/bin/
# The data directory (user accounts; later the snapshot history). Group 0
# may write too, so any user ID with group 0 works (OpenShift).
# (Copied from its parent: a directory copied itself would get mode 0755.)
COPY --from=go --chown=65532:0 /out/root/ /
COPY LICENSE NOTICE /usr/share/doc/ionos-explorer/
ENV IONOS_EXPLORER_MODE=hosted
USER 65532:65532
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["/usr/local/bin/ionos-explorer", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/ionos-explorer"]
LABEL org.opencontainers.image.title="IONOS Explorer" \
      org.opencontainers.image.description="Search and browse an entire IONOS Cloud contract; read-only." \
      org.opencontainers.image.source="https://github.com/K4ugummi/ionos-explorer" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${VERSION}"
