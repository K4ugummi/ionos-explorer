# 07 More hosting targets

**Problem.** The project is open source; people will run it wherever they
run things. Docker Compose and Kubernetes are the tested paths (05). This
package adds the files and notes for the next most common platforms,
without platform-specific code: everything rests on the portability rules
in the plan README.

## Design

### Helm chart (provided)

`deploy/helm/ionos-explorer/`, published as an OCI chart to
`oci://ghcr.io/k4ugummi/charts/ionos-explorer` by the release workflow
(06), version = app version.

- Values mirror the configuration table: `publicUrl`, `oidc.issuer`,
  `oidc.clientId`, `oidc.existingSecret` (keys `client-secret`,
  `age-identity`) or `oidc.clientSecret` + `history.ageIdentity` for
  trials, `oidc.allowedGroups`, `history.enabled|keep|maxUserBytes|shared`,
  `persistence.size|storageClass|existingClaim`, `ingress.*` (className,
  host, path, TLS, annotations), `networkPolicy.enabled|egress`,
  `resources`, `podSecurityContext`/`securityContext` (restricted
  defaults as in 05), `extraEnv`, `image.repository|tag|digest`.
- `replicaCount` is not a value (always 1, `Recreate`); the chart says
  why in `values.yaml`.
- Templates render the same objects as the Kustomize base; a CI test
  renders both with equivalent settings and diffs the important fields
  (security context, probes, volume, env) so they don't drift.
- `helm lint`, `helm template | kubeconform`, `ct lint` in CI; one
  `ct install` on kind with the dev IdP and fake API (nightly).
- `NOTES.txt` prints the URL and the IdP redirect URI to register.

### Podman and systemd (provided)

- **Podman Quadlet** (`deploy/podman/ionos-explorer.container`,
  `.volume`, secrets via `podman secret create`): rootless, read-only,
  `AutoUpdate=registry`, published to 127.0.0.1 behind a host reverse
  proxy.
- **Plain binary + systemd** (`deploy/systemd/ionos-explorer.service`):
  `DynamicUser=yes`, `StateDirectory=ionos-explorer` (→ `DATA_DIR`),
  `LoadCredential=` for the OIDC secret and age identity (read via
  `$CREDENTIALS_DIRECTORY` with the `*_FILE` variables), hardening
  (`ProtectSystem=strict`, `NoNewPrivileges`, `PrivateTmp`,
  `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`,
  `SystemCallFilter=@system-service`), plus Caddy and nginx snippets for
  TLS. `systemd-analyze verify` and `systemd-analyze security` in CI.

### Documented targets (notes in `deploy/README.md`)

For each: what to set, and what does not work.

- **OpenShift:** the Kustomize base or Helm chart with
  `podSecurityContext` left empty (random UID, group 0 works, see 04), a
  Route instead of an Ingress (TLS edge, `insecureEdgeTerminationPolicy:
  Redirect`).
- **Nomad:** a job with one `group` count 1, a host or CSI volume, secrets
  from Nomad Variables or Vault as files; sketch only.
- **AWS ECS/Fargate:** one task, `desiredCount: 1`, EFS for `/data`
  (or S3, below), secrets from Secrets Manager as env, ALB with HTTPS; no
  autoscaling.
- **Azure Container Apps:** `minReplicas = maxReplicas = 1` (no scale to
  zero), Azure Files for `/data` (or S3-compatible storage), secrets as
  env, built-in ingress for TLS; Entra ID as IdP is the natural pairing.
- **Google Cloud Run:** only with `min-instances = max-instances = 1`,
  CPU always allocated, and history in object storage (Cloud Run has no
  volumes that fit); session affinity irrelevant with one instance. Mark
  as "works with caveats".
- **Not supported:** serverless platforms that start an instance per
  request or scale to zero by design (sessions and held tokens would be
  lost all the time), and anything that runs several instances without
  affinity.

### History in object storage (optional backend)

For platforms without good volumes: `HISTORY_BACKEND=s3` with
`S3_ENDPOINT`, `S3_BUCKET`, `S3_PREFIX`, `S3_REGION`, credentials from the
usual `AWS_*` variables or files. Same layout, same age encryption
(the bucket only ever sees ciphertext), same retention, listing by prefix.
Works with IONOS Object Storage, AWS S3, MinIO, Ceph RGW. Implemented
behind the small store interface 03 introduces (`Store`: put, list, get,
delete), with a minimal S3 client (SigV4 signing is small; or
`github.com/minio/minio-go/v7`, Apache-2.0, if that turns out simpler —
decide in the package, note in `NOTICE`). Tested against MinIO in a
container in CI.

## Tests

- Helm: lint, template + kubeconform, drift check against Kustomize,
  nightly `ct install`.
- Quadlet: `podman-system-generator --dryrun` on the unit files; systemd
  unit `verify`/`security` (exposure score below 2.0 as a goal).
- S3 store: the same store test suite as the volume store (03), run
  against MinIO.

## Accept

- `helm install` on kind with the dev IdP and fake API passes the same
  browser check as the Kustomize overlay.
- `deploy/README.md` has a table of all targets with their support level
  (tested / provided / documented) and the one-instance rule stated once,
  prominently.
