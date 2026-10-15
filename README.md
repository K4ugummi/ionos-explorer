# IONOS Explorer

Read-only, contract-wide view of an IONOS Cloud account: global search across
all virtual datacenters, and a 2D architecture diagram showing every
datacenter and the Cross Connects between them.

**Security model:** the explorer UI never calls the IONOS API. A separate,
small, GET-only exporter writes a snapshot file; the explorer only reads
snapshot files. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

| Path | What |
|---|---|
| `exporter/` | Go: `ionos-export` (read-only exporter), `ionos-fixture` (demo data), snapshot container |
| `explorer/` | Vite + React + TypeScript single-page app |
| `schema/` | JSON Schema of the snapshot manifest |
| `fixtures/` | synthetic demo snapshot (14 datacenters, no real data) |
| `docs/` | architecture and [snapshot format](docs/SNAPSHOT_FORMAT.md) |

## Quick start

Requirements: Go ≥ 1.21 (the go command downloads the pinned toolchain,
go1.27.2, automatically; the module needs Go ≥ 1.26), Node ≥ 20.19.

```sh
make fixture        # writes fixtures/demo-contract.ionx
make test           # Go vet/tests, explorer lint/build
make explorer-dev   # http://localhost:5173, then "Load demo snapshot"
```

## Exporting your contract

```sh
make exporter                       # builds bin/ionos-export
bin/ionos-export --list             # every request it can make (GET only)
export IONOS_TOKEN=...              # or --token-file, or IONOS_USERNAME + IONOS_PASSWORD
bin/ionos-export                    # writes ionos-<contract>-<time>.ionx
bin/ionos-export --recipient age1...  -o contract.ionx.age   # encrypted
```

Regions where you use no VPN Gateway just return empty lists; `--skip vpn`
leaves the VPN Gateway API out entirely.

Use a dedicated user with read access to all datacenters. What it may not
read (e.g. `/um/users` for non-admins) is recorded in the snapshot and shown
as "partial visibility"; `--skip /um` leaves it out. Exit code 2 means the
snapshot was written but is partial. Drop the file onto the explorer's
start screen to open it.

## Appliances and manual links

The explorer flags servers that look like routers, firewalls or VPN
endpoints (from image names, firewall rules, LAN placement; always with the
reasons) and draws IONOS VPN Gateway tunnels. Links the API cannot see, such
as an IPsec tunnel between two Cisco VMs, can be added in a resource's
details. So can the IPs VMs really use: for NICs with DHCP off IONOS only
keeps a record that may be outdated (`dhcp:off` finds them), and a
correction, entered per NIC or pasted as a list on the Overview page, is
shown next to the IONOS value. Links and corrections stay in your browser;
export/import them as a file on the Overview page. The demo snapshot comes
with examples (`fixtures/demo-annotations.json`).

Encrypted fixture (for testing the age path):

```sh
cd exporter
go run ./cmd/ionos-fixture -o /tmp/demo.ionx.age --recipient age1...
go run ./cmd/ionos-fixture -o /tmp/demo.ionx.age --passphrase-file pass.txt
```
