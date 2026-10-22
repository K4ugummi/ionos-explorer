# IONOS Explorer

A read-only map of an IONOS Cloud contract. It shows every virtual datacenter,
what runs in it and how the datacenters are connected, in one place.

- **Search** across all datacenters: names, IPs, MACs, labels, kinds
  (`kind:server dc:fra-* label:env=prod`).
- **Diagrams** of the whole contract, of one datacenter, of everything
  connected to a resource, or of the routes between two resources.
- **Appliances**: servers that look like routers, firewalls or VPN
  endpoints are flagged, with the reasons.
- **Changes** between two snapshots, listed and marked in the diagram.
- **Export** of any view as SVG, PNG, PDF or draw.io.
- **Your own notes**: links the API cannot see (an IPsec tunnel between two
  VMs), the IPs VMs really use, box positions.

How to use all of this: [docs/USER_GUIDE.md](docs/USER_GUIDE.md).

## Security model

- Only the Go program talks to the IONOS API, with a client that sends
  **GET requests only**. Nothing in your contract is ever changed.
- The page in the browser talks to nothing but the server it came from: no
  CDNs, fonts or analytics, enforced by its Content-Security-Policy.
- The API token is typed into the page and kept **in the server's memory
  only**, never written to disk or logs. It is forgotten after 30 minutes
  unused, when you press Forget, or when the program stops.
- Fetched data stays in memory until you download it. In hosted mode it can
  also be kept in a per-user history, encrypted with age.

Details: [SECURITY.md](SECURITY.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Ways to run it

| | For | How |
|---|---|---|
| [On your machine](#on-your-machine) | one person | `ionos-explorer`: serves the page on 127.0.0.1, fetches with your token |
| [For a team](#for-a-team) | several users, behind TLS | `ionos-explorer --mode hosted`, usually as a container ([deploy/](deploy/README.md)) |
| [Export to a file](#export-to-a-file) | machines that should only fetch, sharing snapshots | `ionos-export` writes a snapshot file; any explorer opens it |

No release has been published yet. Until then, build from source as below.

## On your machine

Needs Go 1.26 or newer (it fetches the pinned toolchain itself) and Node
20.19 or newer.

```sh
make explorer-app   # builds the UI, then bin/ionos-explorer with the UI embedded
bin/ionos-explorer  # serves http://127.0.0.1:<free port> and opens the browser
```

1. It opens a link ending in `/login?secret=…`. That secret logs this
   browser in: keep it to yourself. Each run makes a new one.
2. Under **Fetch from IONOS**, enter an API token and press **Fetch**.
3. **Refresh** fetches again and shows what changed on the Changes tab.
4. **Download** saves the snapshot as `.ionx`, or as `.ionx.age`, which is
   encrypted in the browser with a passphrase or age recipients. Nothing is
   written to disk before that.

Snapshot files and the demo contract open from the same start screen. Stop
the program with Ctrl+C.

Use a dedicated IONOS user with read access to all datacenters. What it may
not read (`/um/users` for non-admins, say) is shown as "partial visibility".

| Flag | Default | |
|---|---|---|
| `--listen` | `127.0.0.1:0` | a fixed port, e.g. `127.0.0.1:8642` (loopback only) |
| `--open` | `true` | open the browser |
| `--forget-after` | `30m` | forget an unused token after this long (`0`: only on Forget or exit) |
| `--base-url` | | send requests to a local mock instead of IONOS |

`ionos-explorer -h` lists them all. Every flag can also be set as
`IONOS_EXPLORER_<FLAG>` (`IONOS_EXPLORER_LISTEN`), or read from the file
that `IONOS_EXPLORER_<FLAG>_FILE` names.

## For a team

`ionos-explorer --mode hosted` serves several users behind a reverse proxy
that terminates TLS. Each user logs in, types their own IONOS token and sees
only their own fetches.

- **Login**: local accounts kept by the explorer (with an optional second
  factor), an OpenID Connect provider such as Keycloak, Entra ID or Google,
  or both.
- **Snapshot history**: with an age key, every fetch is kept per user,
  encrypted, so the Changes tab can compare with last week or last month.
- **Runs** as a non-root container with a read-only root filesystem. It needs
  one volume and exactly one instance.

To try it on your machine:

```sh
make image
docker run -d --name ionos-explorer --read-only --cap-drop ALL --security-opt no-new-privileges \
  -p 127.0.0.1:8080:8080 -v ionos-explorer:/data \
  -e IONOS_EXPLORER_PUBLIC_URL=http://localhost:8080 ionos-explorer
docker logs ionos-explorer   # the one-time link that creates the first admin
```

Docker Compose (with Caddy for TLS), Kubernetes and Docker Swarm files, the
OIDC setup, the history, backups, and dev setups with a fake IONOS API and a
test Keycloak are all in **[deploy/README.md](deploy/README.md)**.

## Export to a file

For machines that should only fetch (CI, a jump host), or to share
snapshots:

```sh
make exporter                     # builds bin/ionos-export
bin/ionos-export --list           # every request it can make (GET only)
export IONOS_TOKEN=...            # or --token-file, or IONOS_USERNAME + IONOS_PASSWORD
bin/ionos-export                  # writes ionos-<contract>-<time>.ionx
bin/ionos-export --recipient age1... -o contract.ionx.age   # encrypted
```

Open the file on the explorer's start screen: in `ionos-explorer`, or in a
static build of the UI on any web server (`make explorer-build`, then serve
`explorer/dist`; it needs no backend). Exit code 2 means the snapshot was
written but is partial. The format: [docs/SNAPSHOT_FORMAT.md](docs/SNAPSHOT_FORMAT.md).

### What it reads

- **Compute and network:** datacenters, servers with NICs, volumes and
  firewall rules, LANs, Security Groups, NAT gateways, load balancers and
  target groups, Cross Connects, IP blocks, VM Auto Scaling, Kubernetes.
- **Managed services:** PostgreSQL, MariaDB, MongoDB, In-Memory DB, Kafka
  (with topics), Network File Storage, VPN Gateways (tunnels and peers).
- **Everything around them:** Cloud DNS (zones, records, secondary zones,
  reverse records), Certificate Manager, CDN, Container Registry, Logging
  and Monitoring pipelines, images, labels, backup units, volume snapshots,
  users and groups (if allowed).

Object Storage buckets are not read, because listing them needs S3 keys,
not a token. Regional products are asked in every region.
`--skip vpn` (an API family) or `--skip /um` (a path) leaves things out.
The fetch panel's Options take the same patterns.

## Releases

A release (tag `v1.2.3`) publishes:

- the image `ghcr.io/k4ugummi/ionos-explorer` for amd64 and arm64, with
  tags `1.2.3`, `1.2`, `1` and `latest`, an SBOM and build provenance;
- the binaries `ionos-explorer` (UI embedded) and `ionos-export` for Linux,
  macOS and Windows, with `SHA256SUMS`.

Image and checksums are signed with cosign. How to verify them:
[SECURITY.md](SECURITY.md). Without the UI, the commands also install with
`go install github.com/K4ugummi/ionos-explorer/exporter/cmd/ionos-export@latest`.

## Development

| Path | What |
|---|---|
| `exporter/` | Go: `ionos-explorer`, `ionos-export`, `ionos-fixture` (demo data), `ionos-fakeapi` (the demo contract as a fake IONOS API) |
| `explorer/` | the UI: Vite, React, TypeScript |
| `deploy/` | Docker Compose, Kubernetes and Swarm files |
| `fixtures/` | the synthetic demo contract (14 datacenters, no real data) |
| `schema/`, `docs/` | the snapshot format, the architecture |

```sh
make fixture        # writes fixtures/demo-contract.ionx (and -previous, two weeks older)
make test           # Go vet and tests, UI lint, tests and build
make explorer-dev   # http://localhost:5173, then "Load demo snapshot"
```

To work on fetching with hot reload, run the Go server on a fixed port and
point the dev server at it. Then open the printed login link with the port
changed to 5173:

```sh
cd exporter && go run ./cmd/ionos-explorer --listen 127.0.0.1:8642 --open=false
cd explorer && IONOS_EXPLORER_URL=http://127.0.0.1:8642 npm run dev
```

CI runs the same make targets, so every check also runs locally:

- `make test-race` runs the Go tests with the race detector.
- `make vuln` runs govulncheck and npm audit.
- `make check`: no snapshots or credentials are tracked, and the deployment
  files are valid.
- `make lint-actions` checks the GitHub workflows.
- `make image smoke` needs Docker.
- `make e2e-compose` and `make e2e-kind` are the browser checks. They start
  containers or a kind cluster.

Rules for contributions: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Copyright (C) 2026 Stephan Schauerte. Licensed under the
[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`): you may
use, change and share it; if you distribute a changed version or let others
use it over a network, you must publish its source under the same licence.
Third-party components and their licences are listed in [NOTICE](NOTICE).
Not affiliated with or endorsed by IONOS SE.
