# 06 CI and releases

**Problem.** The repo is public on GitHub (`K4ugummi/ionos-explorer`) but
has no CI, no images, no release binaries, and the Go module path is the
local `ionos-explorer/exporter`, so `go install` from GitHub does not work.

## Design

- **Module path** → `github.com/K4ugummi/ionos-explorer/exporter`
  (rewrite imports; one mechanical commit on its own).
- **Workflows** (`.github/workflows/`), all actions pinned by commit SHA,
  `permissions:` minimal per job, Dependabot for actions, Go modules, npm
  and the Dockerfile base images:
  - `ci.yaml` on push and PR: `make test` (Go vet/tests with `-race`,
    oxlint, vitest, tsc, build), `govulncheck`, `npm audit --omit=dev`,
    gitleaks (full history on main, diff on PRs), a check that no `*.ionx`
    other than the two demo fixtures is tracked, `kubectl kustomize` +
    kubeconform, Compose/stack config validation, and the image build
    (amd64 + arm64, not pushed) with the smoke test from 04.
  - `release.yaml` on tags `v*`: build and push
    `ghcr.io/k4ugummi/ionos-explorer:{1, 1.2, 1.2.3, sha}` multi-arch with
    `docker/build-push-action`, SBOM and provenance attestations
    (`--sbom --provenance=mode=max`), Trivy scan (fail on fixable
    critical/high), keyless cosign signature (GitHub OIDC), and release
    binaries `ionos-explorer` and `ionos-export` for linux/darwin/windows ×
    amd64/arm64 with `SHA256SUMS` (signed). GoReleaser if it keeps the
    workflow shorter; otherwise a plain matrix.
  - `e2e.yaml` (nightly and on demand): the Compose dev-idp browser check
    and the kind check from 05.
- **Versioning:** semver tags; `--version` and the UI footer show it; the
  image label `org.opencontainers.image.version` too.
- **Repository hygiene:** `SECURITY.md` (how to report; what the program
  can access; that it is read-only against IONOS), `CONTRIBUTING.md`
  (tests, no real data in issues/PRs, DCO sign-off since the project is
  AGPL and the owner may want to relicense or dual-license later — or a
  CLA; decide with the user), issue templates warning not to paste
  snapshots, branch protection for `main` (CI required).

## Tests

- The workflows themselves run on a PR before merging; `actionlint` in CI.
- A release dry-run on a `v0.0.0-test` tag in a fork or with push disabled.

## Accept

- A PR shows green CI with all jobs above; a tag produces a signed
  multi-arch image on GHCR and release binaries with checksums;
  `cosign verify` and `docker buildx imagetools inspect` show signature,
  SBOM and provenance; `go install
  github.com/K4ugummi/ionos-explorer/exporter/cmd/ionos-export@latest`
  works.
