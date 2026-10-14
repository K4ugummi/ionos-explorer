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

## Guiding constraint: the UI never touches the IONOS API

```
┌──────────────────────┐   snapshot file    ┌─────────────────────────────┐
│  ionos-export (Go)   │ ─────────────────► │  explorer (React/TS)        │
│  read-only token     │  .ionx             │  no credentials             │
│  GET requests only   │  .ionx.age (opt.)  │  no outbound network (CSP)  │
│  small + auditable   │                    │  search, canvas, details    │
└──────────────────────┘                    └─────────────────────────────┘
```

The two halves only share the **snapshot format**
([SNAPSHOT_FORMAT.md](SNAPSHOT_FORMAT.md), [schema](../schema/manifest.schema.json)).

| Concern | Exporter | Explorer |
|---|---|---|
| Credentials | IONOS token (env/file, never argv, never logged, never in output) | none |
| Network | `api.ionos.com` and product API hosts, GET/HEAD only | none: production CSP sets `connect-src 'self'` |
| Logic | fetch, paginate, record coverage, write raw JSON | parse, normalize, index, lay out, render |
| Change rate | rarely (new endpoint = new list entry) | often |

The exporter stays deliberately "dumb": it stores API responses unchanged
(only re-serialized canonically). All interpretation lives in the explorer,
so mapping bugs are fixed without re-exporting and the exporter's audit
surface stays small.

## Components

### Exporter (`exporter/`, Go)

- `cmd/ionos-export`: the CLI (next milestone).
- `cmd/ionos-fixture`: generates a synthetic 14-datacenter contract in the
  exact snapshot format, for development and tests.
- `internal/snapshot`: container writer/reader (zip, manifest, checksums,
  optional age encryption). Shared by both commands.
- `internal/httpx` *(planned)*: an HTTP client whose transport rejects
  everything except GET/HEAD, plus retry, rate-limit handling
  (`X-RateLimit-*` headers) and pagination.
- `internal/endpoints` *(planned)*: the explicit list of endpoints the
  exporter calls. Reviewing this file is reviewing what the tool can do.

No IONOS SDK: plain `net/http` keeps the dependency tree tiny and preserves
every field the API returns (SDKs drop fields they don't model).

Runs non-interactively, so the same binary works for manual runs and CI/cron.
Exit codes: `0` complete, `2` partial (some endpoints forbidden/failed),
`1` fatal.

**Credentials (recommended):** a dedicated non-admin IONOS user in a group
with *read* shares on all datacenters. New datacenters are not shared
automatically. The exporter records `forbidden` coverage and the explorer
surfaces "partial visibility" rather than silently showing less.

### Explorer (`explorer/`, Vite + React + TypeScript)

Static single-page app. Local-first: open it and drop a snapshot in. A static
build can later sit behind nginx + oauth2-proxy (SSO) for a team, with no
code changes.

Planned modules:

- `src/snapshot`: unzip (fflate), decrypt (`age-encryption`, the TS port
  of age), verify checksums against the manifest.
- `src/model`: raw API → normalized graph:
  - **Node** `{id, kind, name, dcId, parentId, labels, searchText, raw}`
  - **Edge** `{kind, from, to}`: `nic→lan`, `lan↔pcc`, `lb→lan`,
    `lb→target`, `natgw→lan`, `server→volume`, `nodepool→lan`,
    `dbaas→lan`, `ipblock→consumer`
- `src/search`: in-memory full-text index (names, IDs, IPs, MACs, labels)
  with filters such as `type:cube dc:fra-prod-core ip:10.7.*`. Every hit shows
  its path: contract › datacenter › LAN › server.
- `src/canvas`: React Flow (xyflow) + ELK.js for hierarchical layout.
  Semantic zoom:
  1. **Contract**: datacenters as boxes grouped by location. Cross Connects
     with two peers draw as an edge; with three or more peers as a small hub
     node (a Cross Connect is one shared L2 segment, not point-to-point links).
  2. **Datacenter**: LANs as network bars; servers, LBs, NAT gateways,
     node pools and DBaaS clusters attached.
  3. **Resource**: detail panel with properties and raw JSON.
- `src/panels`: detail, raw JSON, coverage/visibility report.

### Connectivity the API cannot see

Site-to-site links built *inside* VMs (e.g. Cisco Catalyst 8000V / CSR1000v
or ASAv doing IPsec) are invisible to the IONOS API: it only sees a VM with
NICs. The explorer handles this in three layers:

1. **Appliance detection (heuristic).** A server is flagged as a likely
   network appliance, with the reasons shown, when it matches signals such as:
   boot volume from a private image whose name matches a known vendor
   pattern (`c8000v`, `csr1000v`, `asav`, `fortigate`, `pa-vm`, `vyos`,
   `pfsense`, `opnsense`, …); firewall rules allowing ESP or UDP 500/4500;
   NICs in a public LAN plus one or more private LANs; name/label hints.
2. **IONOS VPN Gateway (managed).** Fetched by the exporter (regional API).
   If a tunnel's remote host matches a public IP in the contract, the
   explorer draws the link automatically. Otherwise it points to an external
   node.
3. **Manual links.** Edges the user adds in the explorer (e.g.
   `fra-core-vpn-01 ↔ txl-core-vpn-01, IPsec`, or to an external site such
   as "HQ on-prem"). Stored in a separate annotations file keyed by resource
   ID, never inside the snapshot, and drawn visually distinct (dashed) from
   API-derived edges.

Snapshot sizes are small (a few MB for hundreds of servers), so everything
runs in the browser. Cytoscape.js is the fallback if React Flow struggles
with very large graphs.

## Security notes

- Snapshots contain IPs, firewall rules, names and (for admin exports) user
  emails. Treat them as confidential. Encrypt with `age` when they leave the
  machine that exported them. The root `.gitignore` refuses `*.ionx` and
  `*.age` except the synthetic fixture.
- The exporter never writes the token, the `Authorization` header, or
  request bodies anywhere.
- The explorer has no backend and blocks outbound requests via CSP. A
  malicious snapshot can at worst render odd text: values are always
  rendered as text, never as HTML.

## Open-source readiness (before publishing)

- License: undecided (Apache-2.0 or MIT are the usual choices for tooling).
- Name: "IONOS" is a trademark. Prefer a neutral name with a "not affiliated
  with IONOS" note, or ask IONOS for permission.
- Go module path: currently the local `ionos-explorer/exporter`; switch to
  the public repo path (e.g. `github.com/<org>/<repo>/exporter`).
- CI: tests, lint, build, plus secret scanning (e.g. gitleaks). Release
  builds of `ionos-export` for Linux/macOS/Windows with checksums.
- History hygiene: no real snapshots, tokens, or company-specific names in
  any commit (`.gitignore` already refuses `*.ionx`/`*.age`).
- `CONTRIBUTING.md`, `SECURITY.md` (how to report issues; what the exporter
  can and cannot access).

## Roadmap

1. ✅ Repo scaffold, snapshot format v1, manifest schema, fixture generator
2. Exporter MVP: Cloud API compute, network and Cross Connects; coverage; age
3. Explorer MVP: load snapshot, global search, detail panel
4. Canvas: contract overview with Cross Connects, datacenter drill-down
5. Appliance detection, VPN Gateway coverage, manual links
6. Wider coverage (DBaaS, Kubernetes, IAM, DNS, …), snapshot diff,
   SVG/PNG/draw.io export
