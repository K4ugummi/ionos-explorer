# IONOS Explorer

Read-only, contract-wide view of an IONOS Cloud account: global search across
all virtual datacenters, and a 2D architecture diagram showing every
datacenter and the Cross Connects between them.

**Security model:** only Go code with a GET-only client talks to the IONOS
API; the explorer in the browser talks to nothing but the server it came
from. Run it as **one program**, `ionos-explorer`, which serves the
explorer on 127.0.0.1 and fetches the contract itself (token typed into
the page, held in memory only, data kept in memory until you download
it), or as **two**: `ionos-export` writes a snapshot file on a machine
that only fetches, and the explorer (any static host, no backend) opens
it. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

| Path | What |
|---|---|
| `exporter/` | Go: `ionos-explorer` (the single binary), `ionos-export` (read-only exporter), `ionos-fixture` (demo data), snapshot container |
| `explorer/` | Vite + React + TypeScript single-page app |
| `schema/` | JSON Schema of the snapshot manifest |
| `fixtures/` | synthetic demo snapshot (14 datacenters, no real data) |
| `docs/` | architecture and [snapshot format](docs/SNAPSHOT_FORMAT.md) |

## Quick start

Requirements: Go ≥ 1.21 (the go command downloads the pinned toolchain,
go1.27.2, automatically; the module needs Go ≥ 1.26), Node ≥ 20.19.

```sh
make explorer-app   # builds the UI, then bin/ionos-explorer with the UI embedded
bin/ionos-explorer  # serves http://127.0.0.1:<free port>, opens the browser
```

It prints a link `http://127.0.0.1:<port>/login?secret=…` and opens it
(the secret logs this browser in; keep it to yourself, each run has a new
one). In the page, under **Fetch from IONOS**, enter an API token and
press Fetch: the program reads the contract with GET requests only
(progress, Cancel), and the explorer opens. The token goes to the local
program only and stays in its memory for **Refresh** until you press
**Forget** (✕ next to "token held"), stop the program, or 30 minutes pass
unused (`--forget-after`); untick "Keep the token" to have it dropped
after the fetch. **Refresh** fetches again and compares with the snapshot
open before (Changes tab). Nothing is written to disk until you press
**Download** (`.ionx`, or `.ionx.age` encrypted in the browser with a
passphrase or age recipients). Opening files and the demo work as well.
Stop it with Ctrl+C.

Flags: `--listen 127.0.0.1:8642` (a fixed port; loopback addresses only),
`--open=false` (do not open the browser), `--forget-after 0` (keep the
token until Forget or exit), `--base-url` (a local mock instead of IONOS).
A plain `go build ./cmd/ionos-explorer` works too, but without the UI
(the page says so); `make explorer-app` embeds it.

Development:

```sh
make fixture        # writes fixtures/demo-contract.ionx (and -previous, two weeks older)
make test           # Go vet/tests, explorer lint/tests/build
make explorer-dev   # http://localhost:5173, then "Load demo snapshot" (no fetching)
```

To work on the fetch feature with hot reload, run the Go server on a fixed
port and point the dev server at it; Vite then proxies `/api` and `/login`
to it:

```sh
cd exporter && go run ./cmd/ionos-explorer --listen 127.0.0.1:8642 --open=false
cd explorer && IONOS_EXPLORER_URL=http://127.0.0.1:8642 npm run dev
```

and open the printed login link with the port changed to 5173.

## Exporting your contract to a file

For machines that should only fetch (CI, a jump host), or to share
snapshots:

```sh
make exporter                       # builds bin/ionos-export
bin/ionos-export --list             # every request it can make (GET only)
export IONOS_TOKEN=...              # or --token-file, or IONOS_USERNAME + IONOS_PASSWORD
bin/ionos-export                    # writes ionos-<contract>-<time>.ionx
bin/ionos-export --recipient age1...  -o contract.ionx.age   # encrypted
```

Regions where you use no VPN Gateway just return empty lists; `--skip vpn`
leaves the VPN Gateway API out entirely (the fetch panel's "Options" take
the same patterns).

Use a dedicated user with read access to all datacenters. What it may not
read (e.g. `/um/users` for non-admins) is recorded in the snapshot and shown
as "partial visibility"; `--skip /um` leaves it out. Exit code 2 means the
snapshot was written but is partial. Drop the file onto the explorer's
start screen to open it (`bin/ionos-explorer`, or a static build of
`explorer/` on any web server: `make explorer-build`, then serve
`explorer/dist`).

## Appliances and manual links

The explorer flags servers that look like routers, firewalls or VPN
endpoints (from image names, firewall rules, LAN placement; always with the
reasons) and draws IONOS VPN Gateway tunnels. A server in four or more
LANs is drawn as a router: one line to its first LAN, the others while it
or one of those LANs is selected; LANs only it uses fold into its box, and
a LAN that only leads to a Cross Connect becomes a line from the router to
the Cross Connect ("+N LANs only here" unfolds them). Groups of more than
eight servers show six and a "+N more" box that expands them; the selected
server, appliances and changes since a compared snapshot are always shown,
and search hits among the hidden ones are counted on the box. Zoomed out,
the diagram shows less: below 60 % no subtitles or IPs, below 30 % only
names; the selection, its neighbours and search hits keep their details.
"Layers" in the diagram bar hides load balancers, gateways, managed
services, tunnels and links, leftover groups or Cross Connect peers (the
layout closes the gap), or dims all but appliances or, when comparing, all
but changes; the choice is remembered in this browser. A resource picked
in search that a hidden layer leaves out gets a note with a "Show" button.
On the contract view, tunnels and links between locations are routed
around the datacenter cards.
**Own positions.** Drag a box, a datacenter card or a group (location,
server group) in the contract or a datacenter view to place it yourself;
it stays there, its lines follow as right-angled steps, and the automatic
layout keeps placing everything else. With the keyboard, the selected box
moves with the arrow keys (Shift: further); on a touch screen, tap a box
first, then drag it. "Reset layout" in the diagram bar puts the view back.
Positions are saved with the links and IP corrections below (also in the
exported file).
**Focus and paths.** "Focus" in a resource's details shows what it is
connected to across datacenters, 1–3 hops out (a LAN, a Cross Connect, a
server each count as one): its datacenter and the ones behind its Cross
Connects, drawn by the same rules. "Path to…" picks a second resource and
shows the shortest routes between them, step by step in the details and
as a diagram grouped by datacenter. Routes pass LANs, Cross Connects, load
balancers (listener to target), VPN gateways and tunnels, manual links and
sites, and servers detected as appliances; other servers in two LANs only
as a last resort, marked as such. With no route, both neighbourhoods are
shown with a hint to add the missing link. Both views live in the URL
(`focus=`, `path=`, `hops=`); the breadcrumbs, ✕ or the browser's back
button return to the view before.
**Export.** "Export" in the diagram bar saves the current view (all
datacenters, one datacenter, a focus or a path) as an SVG image, a PNG
image at twice the size, or a draw.io file to edit in diagrams.net:
the picture as laid out, with your box positions, hidden layers and
collapsed groups, at full detail whatever the zoom, always in light
colours, with title, snapshot date and legend; selection and search
highlighting are left out, comparison markers kept. Files are named
`ionos-<contract>-<view>-<snapshot date>.svg|png|drawio` and made in the
browser; nothing is uploaded.
Links the API cannot see, such as an IPsec tunnel between two Cisco VMs, can
be added in a resource's details. So can the IPs VMs really use: for NICs with DHCP off IONOS only
keeps a record that may be outdated (`dhcp:off` finds them), and a
correction, entered per NIC or pasted as a list on the Overview page, is
shown next to the IONOS value. Links, corrections and box positions stay in
your browser; export/import them as a file on the Overview page. The demo snapshot comes
with examples (`fixtures/demo-annotations.json`).

**Comparing snapshots.** On the Changes tab, load an older snapshot of the
same contract: everything added, removed or changed in between (servers,
NICs and IPs, firewall rules, LANs, Cross Connects, labels, …) is listed by
datacenter, marked in the diagram, and searchable with `is:added` and
`is:changed`. With `ionos-explorer`, Refresh does this by itself: the
snapshot open before becomes the older one. With the demo, "Compare with the demo two weeks earlier" loads
`fixtures/demo-contract-previous.ionx`.

Encrypted fixture (for testing the age path):

```sh
cd exporter
go run ./cmd/ionos-fixture -o /tmp/demo.ionx.age --recipient age1...
go run ./cmd/ionos-fixture -o /tmp/demo.ionx.age --passphrase-file pass.txt
```

## License

Copyright (C) 2026 Stephan Schauerte. Licensed under the
[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`): you may
use, change and share it; if you distribute a changed version or let others
use it over a network, you must publish its source under the same licence.
Third-party components and their licences are listed in [NOTICE](NOTICE).
Not affiliated with or endorsed by IONOS SE.
