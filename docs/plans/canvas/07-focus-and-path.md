# 07 Focus and path view

The two views a network diagram is really used for: "what is this connected
to" and "how does A reach B". Both work across datacenters, which the
per-datacenter view cannot show.

## Model: `explorer/src/model/paths.ts` (pure, tested)

- **Network graph** from the model: nodes are servers, NICs, LANs, Cross
  Connects, NAT/VPN gateways, load balancers, managed services, external
  endpoints, sites; edges from `model.edges`: `member`/`attached`
  (server/NIC ↔ LAN), `cross-connect` (LAN ↔ Cross Connect), `gateway`
  (NAT ↔ LAN), `connection` (managed service/VPN gateway ↔ LAN), `listener`
  and `target-lan` (LB ↔ LAN), `target` (LB → server), `tunnel` (VPN ↔
  remote), `manual` (user links). Treat them as undirected for reachability.
- `neighbourhood(model, id, hops)`: everything within `hops` (default 2,
  counting LANs and Cross Connects as hops), across datacenters.
- `findPaths(model, a, b, { max: 3 })`: shortest paths by hop count (BFS,
  then the k shortest without repeated nodes). A path is a list of node ids
  with the edge kind between each pair. Servers in the middle of a path are
  allowed only if they look like appliances (`node.appliance`) or have
  NICs in both LANs: that is how traffic is routed through firewall VMs.
  Explain each step in words ("member of LAN app", "Cross Connect
  fra-backbone to txl-prod-core", "routed by fra-core-fw-01 (likely
  firewall)").
- Annotations matter: manual links and sites are part of the graph (use the
  applied model).

## Views

- **Focus**: details panel button "Focus" (servers, LANs, gateways,
  Cross Connects) → diagram mode `focus=<id>` in the hash. A diagram built
  from `neighbourhood` (new builder `focusDiagram` in `build.ts`): the
  selected resource in the middle, grouped by datacenter, same node
  renderers. "Hops: 1 2 3" control.
- **Path**: details panel "Path to…" opens a resource picker (reuse the
  search picker from `ui/ManualLinks.tsx`) → mode `path=<a>,<b>`. A
  left-to-right diagram of the paths (`pathDiagram`): A, then each hop
  (LAN, Cross Connect, router, …) to B; several paths stacked. A text list
  of the steps in the details panel, so it is usable without the canvas.
- No path found: say so and show the two neighbourhoods side by side, with
  the hint that tunnels or routes inside VMs can be added as manual links.
- Breadcrumbs: "All datacenters › Path: web-01 → db-02", back returns to
  the previous view.

## Tests

- `paths.test.ts` on the demo: a web server in `fra-prod-core` to the
  database in `fra-prod-data` goes through the shared Cross Connect;
  `txl-core-vpn-01` reaches `fra-core-vpn-01` only through the manual link
  (demo annotations) or the managed VPN tunnel; neighbourhood hop counts.
- Builder tests for `focusDiagram`/`pathDiagram` (node types, ordering).

## Accept

- Browser: Focus on a firewall shows its LANs, their members (collapsed
  groups per package 03) and Cross Connect peers in other datacenters.
  Path from a London proxy to a Frankfurt API server shows a route or a
  clear "no route" message.

## Left over

Done 2026-10-15. Notes and deviations:

- **Code.** `model/paths.ts`: `networkGraph` (cached per model),
  `networkNode` (NIC, volume, tunnel → server or gateway), `neighbourhood`,
  `findPaths` (cached), `describePath`, `nodeLine`. `build.ts`:
  `focusDiagram(model, centres, { hops, expanded, selected, hidden })`,
  `pathDiagram(model, paths, { down })`, `DiagramOptions.pinned`.
  `NodeData.focus`, `Diagram.directed`. `ui/mode.ts` (hash `focus=`,
  `path=`, `hops=`), `ui/PathPanel.tsx`, "Focus" and "Path to…" in
  `DetailPanel`, the search picker of the manual-link form moved into
  `ResourcePicker` (`ManualLinks.tsx`, Enter picks the first hit, Escape
  cancels), hops control, breadcrumbs and notes in `DiagramView.tsx`,
  `LayersMenu` got a `scope` (contract, datacenter, path).
- **Hops.** Every node on the way counts as one (a LAN, a Cross Connect, a
  server; NICs do not): from a server, 1 is its LANs, 2 what else is on
  them and their Cross Connects, 3 the LANs behind those.
- **Deviation: which servers route.** "Appliance or NICs in both LANs" is
  always true for a server in the middle of a path (it got there through
  both LANs). Built as a cost instead: appliances are free, any other
  server costs `PLAIN_SERVER_COST` (1000) hops, so routes through
  appliances always win and other multi-homed servers are a last resort,
  flagged "through a server not known to route" and worded "through
  data-etl-01 (in both LANs; only if it forwards)". The plan's own example
  needs it: in the demo, fra-prod-data's databases are reachable only
  through the ETL servers. Load balancers pass traffic only from their
  listener LAN to a target (else every target server reached "back"
  through its balancer); NAT gateways, node pools and PostgreSQL end a
  path; endpoints outside the contract (sites, VPN peers) may be passed.
- **Added: alternatives, twins, shortcuts.** Without them the three
  shortest routes were fw-01, fw-02 and fw-01 again with etl-02. A node
  that joins the same two neighbours at the same cost is an alternative of
  that step ("routed by fra-core-fw-01 (…), or fra-core-fw-02,
  fra-core-hub-01"), drawn beside it; paths that differ only by those are
  one route. Twins (same kind, same neighbours, both appliances or
  neither: an HA pair, a web farm) are searched through once; with that
  and a lower iteration cap, 1480 demo server pairs took 3.8 s instead of
  14.5 s. A path two of whose inner nodes are
  neighbours (in through fw-01, out through fw-02) is left out; a direct
  link between the two ends does not count as such a shortcut, so
  txl-core-vpn-01 → fra-core-vpn-01 lists the manual link and then the
  tunnel routes.
- **Deviation: "in the middle".** ELK's layered layout cannot centre one
  box. The focus is marked (outline, keeps its detail at every zoom), the
  view is fitted whole when it opens, and the boxes are ordered from the
  focus outwards (its datacenter, the Cross Connects and endpoints next to
  it, the datacenters behind them, peers), so the picture reads from the
  focus down. A Cross Connect focus sits on top of its datacenters.
- **Deviation: the path diagram is grouped by datacenter and turns.** Left
  to right as planned when the free canvas is wider than tall, top to
  bottom otherwise. The details drawer is always open in a path view, so
  at 1500 px the canvas is 660 × 880: left to right, web-01 → pg-orders-prod
  was 2594 × 246 (fitted at 0.23), top to bottom it fits at about 0.5.
  Boxes are grouped by datacenter (two LANs are called transit-fra) with
  Cross Connects and sites between the groups; the diagram is `directed`,
  so the linked layout keeps lines pointing from start to end (with the
  06 rule, "from the earlier group to the later one", fra-data-sync landed
  below fra-prod-data and its line looped back up).
- **Layout rules (layout.ts).** Two additions, needed for focus views:
  in a linked box a group no routed line enters (a packed server group,
  lines end at its box) keeps its own algorithm (before, its members were
  laid out as one layer: a single row); and a line between two top-level boxes joins
  them into a linked box (hub → peer lines had no route, the packing root
  routes nothing). Plus `directed`. The contract and all 14 datacenter
  views of the demo lay out identically before and after (15/15, compared
  in Node with the previous `layout.ts`); layout times unchanged (contract
  20–22 ms, fra-prod-core 20 ms, median of 31).
- **Focus diagram.** Each datacenter in reach is drawn by
  `datacenterDiagram` on the model cut down to the neighbourhood (so
  routers, folded LANs, collapsed groups per 03, layers per 05, selection
  pinning and change markers all apply) and becomes a group; every
  datacenter has its own internet box. A LAN with anything out of reach on
  it is not folded into its router (at hops 1 a router's LANs would
  otherwise all be "only here"). Cross Connects lead to a peer box for a
  datacenter none of whose LANs on it are in reach. Something in reach the
  datacenter rules did not draw (a VPN gateway whose LANs are out of
  reach) gets a box of its own. The focus is pinned, so it is never
  hidden in a "+N more" box.
- **Focus and Path buttons** for every network resource: servers, LANs,
  gateways, Cross Connects as planned, also load balancers, node pools,
  PostgreSQL and sites/external endpoints; not for NICs, volumes or
  datacenters. They work from the Overview and Changes tabs too (switch
  to the diagram).
- **Navigation.** Entering a mode pushes a history entry and keeps `dc`
  (the view to return to); the crumbs read "All datacenters ›
  fra-prod-core › Focus: fra-core-fw-01 ✕" (below 520 px only the mode
  and ✕). The datacenter crumb, ✕ and the browser's back button return to
  it; changing hops replaces the entry. A resource picked in search while
  in a mode is only selected; if the view does not contain it, a note
  "gpu-trainer-01 is not in this focus view" offers "Show in its diagram".
  A peer box opens that datacenter and leaves the mode. In a path view the
  drawer shows the steps; a step selects its resource (canvas and
  details), "‹ Path steps" goes back, ✕ closes the path view, "Reverse"
  swaps the ends.
- **Tests.** `paths.test.ts` (12): graph shape (no NICs, undirected,
  tunnels from the gateway, ALB targets past the target group),
  `networkNode`, neighbourhood counts for fra-core-fw-01 (6 / 22 / 28 at
  hops 1/2/3, the third hop's LANs in fra-mgmt, fra-prod-core,
  fra-prod-data, fra-prod-shop), web-01 → pg-orders-prod through
  fra-backbone (alternatives, `plain`, every step's words), appliances
  before plain servers (web-01 → db-01 via fw-01, the API servers are no
  alternative), txl-core-vpn-01 → fra-core-vpn-01 via the manual link,
  then only through the vpngw-mgmt tunnel, none without either, London
  proxy → Frankfurt API via the head office and nothing without the demo
  links, load balancer direction, self/NIC of the same server, and 8 × 74
  server pairs all valid (no repeats, no shortcuts, ≤ 3) in about 1.5 s.
  `focus.test.ts` (11): the firewall focus (one group, 5 LANs, server
  groups, focus marked, hubs top level, 3 peers, own internet box), LANs
  not folded at hops 1 but the hub's partner LANs folded at hops 3,
  datacenters behind Cross Connects at hops 3 and the order focus →
  hubs → others, collapse and expand of shop-web, layers (lb, peers,
  links), tunnels and links around the head office, the no-route view,
  every line routed and shop-web packed in ELK; path diagram order,
  groups, alternatives, kinds, directed, top to bottom with all lines
  routed, manual and tunnel lines. `mode.test.ts` (3). `layout.test.ts`
  (+3): top-level lines join a linked box, a packed group keeps its
  algorithm (fails with the old rule), `directed` keeps the order; the
  signature changes with `directed`. 135 → 164 tests; `make test` passes
  (oxlint 0 warnings).
- **Browser (demo, 1500 × 950 unless said).** Accept 1: Focus on
  fra-core-fw-01 (from its datacenter view): group fra-prod-core with its
  5 LANs, 15 resource boxes (server groups fra-core-api, -db, -fw, -web;
  hub, NAT, NLB, VPN), Cross Connects fra-backbone and fra-mgmt, peers
  fra-prod-data, fra-prod-shop, fra-mgmt; fitted at 0.31, the firewall
  marked. Hops 3 (keyboard): 5 groups (fra-prod-core, fra-mgmt,
  fra-prod-data, fra-prod-shop, and txl-prod-core through the manual
  link), 9 LANs, no peers; hops 1: 5 LANs and the firewall. Focus on
  fra-backbone: shop-web 6 + "+6 more", a click shows 12 and "Collapse".
  Accept 2: lhr-proxy-01 → fra-core-api-01 (demo links): 3 routes of 10
  hops, all via lhr-edge-gw-01 (Cisco ASAv), the manual link to Head
  office and its tunnel to vpngw-mgmt; groups lhr-prod-edge, fra-mgmt,
  fra-prod-core, txl-prod-core, fitted at 0.51. No route: gpu-trainer-01
  (fra-lab) → fra-core-api-01 shows "No route between … Showing what is
  near each." on the canvas, "No route found" with the manual-link hint in
  the drawer, both neighbourhoods and the hops control. Search "shop-web"
  in a focus: 12 hits, 14 boxes dimmed. Layers: load balancers off removes
  the NLB from the focus; in a path view all 6 switches are greyed ("a
  path shows everything it passes"). Comparing: the hub-01 focus shows
  its "added" bar and api-01's "changed" bar. Keyboard: Enter on Focus,
  on the hop radios, on "Path to…" (focus lands in the picker, Escape
  closes it, typing and Enter picks the first hit), on ✕. Back: the
  datacenter crumb gives the exact hash from before; browser back and
  forward switch between the two, the focus laid out once (2 ELK runs
  for datacenter + focus in the whole sequence). Light, dark and 390 px:
  no horizontal overflow, no console errors or warnings, no requests to
  other hosts. Screenshots: `shots07/focus-fw-*.png`, `path-*.png`,
  `focus-backbone-open-light.png`, `focus-hub-compare-light.png`.
- **Times (Node, ELK bundled, median of 21).** Focus fra-core-fw-01 at
  hops 1/2/3: build 1.2 / 7.9 / 24.8 ms, layout 21 / 50 / 48 ms. Paths
  web-01 → pg-orders-prod and lhr-proxy-01 → fra-core-api-01 (top to
  bottom): layout 34 / 38 ms. Path search on the demo: 0.1–35 ms per pair.
- **Real snapshot (counts only).** Network graph 263 nodes, 275 edges
  (17 ms); 177 servers, 4 of them appliances. Neighbourhood per server:
  hops 1 median 2 (max 17), hops 2 median 23 (max 56), hops 3 median 25
  (max 58). All 31152 ordered server pairs: 29756 have a route; 173
  servers reach all 172 others, 4 reach none; every first route goes
  through appliances only (0 needed a plain server), 190 have
  alternatives; at most 2 routes per pair (median 1); the first route has
  median 8, p95 16, max 16 hops. Path search: median 0.3 ms, p95 1.3 ms,
  max 13.4 ms. The largest focus (hops 2): 58 boxes, 31 lines, all routed,
  built in 23 ms, laid out in 325 ms cold (85 ms at hops 3); it is
  8081 × 771, because one LAN with 28 boxes on it is one row. That is
  inherited: the real datacenter view of that datacenter is already
  8499 × 594. The longest path (16 hops) is 17 boxes in 5 groups, all
  lines routed, 54 ms.
- **Limits.** Routing is a guess from placement: no route tables, firewall
  rules or Security Groups are read, and the internet is no node, so two
  datacenters that talk over public IPs show "no route" unless a tunnel or
  manual link joins them. A box at the edge of a focus shows only the LANs
  in reach (a router's "N LANs" too). At most three routes are listed.
  Lines in a path view can cross a group's title strip (06) and, when the
  route goes back to a datacenter drawn above (a tunnel), loop around the
  picture. The minimap can cover the bottom right of a fitted view (as in
  all views). On a phone the drawer covers 60 % of the canvas; the step
  list is the usable view there. Manual links to datacenters or Kubernetes
  clusters are not part of the network graph. A busy LAN puts all its
  boxes in one row (see the real snapshot above), in the focus view as in
  the datacenter view; wrapping such rows would be a package of its own.
  A focus view is rebuilt on every selection (up to 25 ms on the demo at
  hops 3, the layout is reused).
- **Not done.** Highlighting one route of several on the canvas from the
  step list; copying or exporting the steps; routes over the internet
  between public LANs.
