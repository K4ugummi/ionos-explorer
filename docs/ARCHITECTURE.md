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

- `cmd/ionos-export`: the CLI. `--list` prints every request it can make
  without needing credentials or network.
- `cmd/ionos-fixture`: generates a synthetic 14-datacenter contract in the
  exact snapshot format, for development and tests.
- `internal/endpoints`: the explicit list of endpoints the exporter calls.
  Reviewing this file is reviewing what the tool can read.
- `internal/httpx`: the only network access. Its transport refuses anything
  but GET/HEAD, any host but the configured API hosts, plain http except to
  loopback, and request bodies. Redirects are not followed. It adds the
  credentials itself and retries 429 (honouring `Retry-After`), 5xx and
  network errors with exponential backoff.
- `internal/export`: runs the plan (top-level collections, then one request
  per datacenter / cluster), up to `--parallel` requests at a time.
  Pagination is driven by `offset`/`limit`, never by following
  `_links.next`, and pages are merged. Ids from responses become URL path
  segments only if they look like ids. Coverage records every request's
  outcome; when a parent is not readable, its children are recorded as
  `skipped` with the reason.
- `internal/snapshot`: container writer/reader (zip, manifest, checksums,
  optional age encryption). Shared by both commands.
- `internal/fakeapi`: serves a snapshot back as the IONOS API would
  (paginated, with error bodies), so tests run the exporter end to end
  against the demo contract and check that it reproduces it byte for byte.

No IONOS SDK: plain `net/http` keeps the dependency tree tiny and preserves
every field the API returns (SDKs drop fields they don't model).

Runs non-interactively, so the same binary works for manual runs and CI/cron.
Exit codes: `0` complete, `2` written but partial (some endpoints
forbidden/failed; endpoints excluded with `--skip` don't count), `1` failed
and nothing written (including HTTP 401 on the first request).

Credentials come from `--token-file`, `IONOS_TOKEN`, or
`IONOS_USERNAME`/`IONOS_PASSWORD`, never from arguments. They are not
logged, not part of any error message, and not in the snapshot. Output files
are written atomically with mode 0600 and not overwritten without `--force`.

**Credentials (recommended):** a dedicated non-admin IONOS user in a group
with *read* shares on all datacenters. New datacenters are not shared
automatically. The exporter records `forbidden` coverage and the explorer
surfaces "partial visibility" rather than silently showing less.

### Explorer (`explorer/`, Vite + React + TypeScript)

Static single-page app. Local-first: open it and drop a snapshot in. A static
build can later sit behind nginx + oauth2-proxy (SSO) for a team, with no
code changes.

Modules:

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
- `src/diagram`: React Flow (xyflow) for rendering, ELK.js (in a web worker)
  for layout. A diagram is pure data derived from the model, with fixed node
  sizes so it can be laid out before rendering. Nodes cannot be dragged; ELK
  routes every edge orthogonally. Two levels:
  1. **Contract**: datacenter cards grouped by location, packed to fit the
     screen. Cross Connects with exactly two peer datacenters draw as a
     line; with any other number as a hub node (a Cross Connect is one
     shared L2 segment, not point-to-point links). Cross Connects without
     visible peers get their own box. Double-click or "Open diagram" drills in.
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
  out again; like lines across group borders they are drawn as curves, from
  the top of a box when the other end lies above it.

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

  Layouts are cached by a *layout signature* (`layoutSignature` in
  `layout.ts`: node ids, types, parents, sizes, ELK options and the edges ELK
  routes), the 30 most recently used kept. A model rebuilt for annotations
  or a comparison reuses them: new titles, change markers and links ELK
  does not route are put on the cached positions (`withData`). Only a new
  box or a new link between siblings lays a view out again. Each view is
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
  pools, PostgreSQL), VPN tunnels and manual links, the leftover groups
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
  browser in `localStorage` (`ionos-explorer:layers`); a changed layer
  reframes a view the canvas had framed. The legend lists only the line
  kinds the current diagram draws. React Flow, the ELK
  client and the canvas are a chunk of their own, fetched when the user
  starts opening a snapshot (first click, key or drag on the open screen);
  the 1.6 MB ELK worker is fetched on the first layout.
- `src/ui`: open screen, search panel, detail panel (properties, connections, contents, raw JSON), contract overview with the visibility report. Selection and query live in the URL hash.

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
   reported. Drawn dotted orange; VPN tunnels dashed magenta.
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
  (see SNAPSHOT_FORMAT.md) in case an API returns one.
- The explorer has no backend and blocks outbound requests via CSP. A
  malicious snapshot can at worst render odd text: values are always
  rendered as text, never as HTML.

## Open-source readiness (before publishing)

- License: undecided (Apache-2.0 or MIT are the usual choices for tooling).
  Third-party licenses to carry in a NOTICE file: elkjs is EPL-2.0 (shipped
  unmodified as a separate worker file), the rest of the bundle is MIT/ISC/BSD.
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
2. ✅ Exporter MVP: Cloud API compute, network and Cross Connects, DBaaS PostgreSQL (v2, regional since the first real run); coverage; age
3. ✅ Explorer MVP: load snapshot (incl. age), global search, detail panel
4. ✅ Diagram: contract overview with Cross Connects, datacenter drill-down
5. ✅ Appliance detection, VPN Gateway coverage, manual links and sites
6. ✅ IP corrections, Security Groups, comparing snapshots
7. Wider coverage (DNS, other DBaaS, NFS, Object Storage, …),
   SVG/PNG/draw.io export
