# IONOS Explorer

Read-only, contract-wide view of an IONOS Cloud account: global search across
all virtual datacenters, and a 2D architecture diagram showing every
datacenter and the Cross Connects between them.

**Security model:** the explorer UI never calls the IONOS API. A separate,
small, GET-only exporter writes a snapshot file; the explorer only reads
snapshot files. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

| Path | What |
|---|---|
| `exporter/` | Go: `ionos-export` (planned) and `ionos-fixture`, snapshot container |
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
make explorer-dev   # http://localhost:5173
```

Encrypted fixture (for testing the age path):

```sh
cd exporter
go run ./cmd/ionos-fixture -o /tmp/demo.ionx.age --recipient age1...
go run ./cmd/ionos-fixture -o /tmp/demo.ionx.age --passphrase-file pass.txt
```
