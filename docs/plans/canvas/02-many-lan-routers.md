# 02 Servers in many LANs

**Problem.** In `datacenterDiagram` every device draws one edge per LAN it
sits on (`first` LAN → box, box → each other LAN). A router or firewall VM
in 16 LANs draws 16 long lines across the datacenter view, crossing
everything; with several such servers the view becomes unreadable. Real
contracts have servers in 7, 8 and 16 LANs.

## Design

A device with `lans.length >= MANY_LANS` (4; reuse `MANY_LANS` from
`model/appliances.ts`) becomes a **router box**:

- Its own node type `router` (new `DiagramNodeType`), wider than a resource
  box (`SIZE.router`, e.g. 280 × 72), showing the name, the appliance tag if
  any, the first IP, and a compact line "16 LANs".
- **Always drawn:** one edge to its first LAN (lowest tier, i.e. nearest the
  internet, as `d.lans` is already sorted), plus edges to LANs that only
  this router connects (otherwise those LANs would float unconnected).
- **On demand:** the remaining LAN edges get `onDemand: true`, so they are
  drawn only while the router or one of those LANs is selected (`flow.ts`
  already handles `onDemand` for load balancer targets).
- The router box lists its LANs on hover/selection: the details panel
  already does this ("LANs" in Connections), so the canvas only needs the
  count.
- LANs that a router reaches on demand show a small marker on their box
  ("via fra-core-fw-01", or "via 2 routers") so nothing looks unconnected.
  Add `NodeData.via?: string`.
- Tiering: LANs still get their level from all memberships (the BFS in
  `datacenterDiagram` uses every device's LANs), so the vertical order does
  not change; only what is drawn does.
- Groups: servers with identical LAN sets are grouped (`groups` by stem +
  LANs). A group of routers (e.g. an HA pair in the same 8 LANs) becomes
  one router-style group: the group carries the edges as today, and the same
  always/on-demand split applies to the group's edges.

Keep the threshold as a named constant with a comment explaining it.

## Tests (`diagram.test.ts`)

- Add a server in ≥ 4 LANs to the demo (the fixture already has
  `fra-core-hub-01` in 4 LANs and the `fra-core-fw-0x` pair in 5); assert:
  the router's box type is `router`; exactly the first-LAN edge (plus edges
  to LANs only it serves) are not `onDemand`; all others are; LANs reached
  on demand carry `via`.
- A server in 3 LANs is unchanged (normal box, all edges drawn).
- A synthetic model with one server in 16 LANs (build it in the test like
  `scale.test.ts`): at most 2 always-drawn edges from it.

## Accept

- Browser on the demo, `fra-prod-core`: the firewall pair and the hub show
  as router boxes; few lines at rest; clicking a router draws all its LAN
  lines and highlights them; clicking a LAN with a `via` marker draws the
  router's edge to it.
- Layout time for `fra-prod-core` not worse than before (report it).
- Counts-only check on the real snapshot (if present): for each datacenter
  view, number of always-drawn edges before/after (print the numbers only).

## Left over

Done 2026-10-15. Notes and deviations:

- **Rule.** `ROUTER_LANS = MANY_LANS` (4) in `build.ts`; `routerLines`
  decides per router box which LAN lines wait for a selection. "LANs only
  this router connects" means: no non-router device (server, NAT, load
  balancer, node pool, …) sits on it and no earlier router has it as its
  first LAN. Of two routers sharing such a LAN, the first (by name) draws
  it, so in the demo the firewall pair keeps `mgmt` and `fra-core-hub-01`
  reaches it on demand. Cross Connects and the internet do not count as
  connecting a LAN.
- **Boxes.** `router` node type, 280 × 72, BoxNode with a third line
  "N LANs" and a green bottom bar; a router group keeps type `group` (it
  needs children) with `data.lans`, "N LANs" in its label and the same bar.
  LANs get `data.via` (router title, or "2 routers") shown as a dashed pill;
  the tooltip says to select the LAN. No legend entry: it pushed the
  datacenter legend into the "Legend" button at 1500 px.
- **Added (not in the plan):** on-demand lines are curves, and a router's
  LAN above it used to be reached from the bottom handle, looping through
  the boxes below. Boxes now have a second pair of handles and `toFlow`
  draws any unrouted line to a box that lies above from the top into its
  bottom. This also changes upward curves in the contract view (tunnels
  and links to the "Outside the contract" group now leave the top of the
  lower box).
- **Demo, fra-prod-core (first step, before folding).** Always-drawn
  edges 26 → 20 (30 in total); at rest the fw group draws 2 lines (was 5),
  the hub 1 (was 4). ELK layout in Node median 49–54 → 40–43 ms (30 runs);
  open → LANs drawn in the browser median 438–456 → 396–400 ms (7 runs
  each, routers off/on alternating). The view got wider and flatter.
- **Real snapshot after the first step (counts only):** 16 views, 4 router
  boxes (in 16, 8, 8 and 7 LANs); always-drawn edges 278 → 277. The
  routers' further LANs were almost never shared: of 15 / 7 / 7 / 6, 10 /
  7 / 1 / 0 had nothing else on them and 5 / 0 / 5 / 6 only a Cross
  Connect, so the plan's rule kept those lines. The user decided to fold
  them ("fold stub + transit"):

### Fold stub + transit (second step)

- **Rule.** `foldedLans` in `build.ts`: a non-public LAN whose only box is
  one router box (a router or a router group; no other device, no second
  router) folds into it. Without a Cross Connect it is a *stub*: no box,
  counted as "+N LANs only here" on the router (`data.only`, a button that
  selects the router or, for a group, its first member; tooltip lists the
  names). With Cross Connects it is a *transit* LAN: no box, and instead of
  LAN → hub the view draws router → hub (`cross-connect`, labelled with the
  LAN name, `ref` = the LAN, so a click selects it); hub and peers as
  before. A LAN between two routers, a public LAN, and LANs of servers in
  fewer than 4 LANs never fold. The router's always-drawn LAN line is its
  first LAN that is not folded; a router whose LANs all fold stands alone
  with its transit lines.
- **Anchors.** Stub LAN → the router box. Transit LAN → the router → hub
  line (the first one if it has several Cross Connects). A manual link or
  tunnel to a folded LAN starts at the router box (`local()` falls back to
  `folded`), never at a line.
- **Fixture.** To show it in the demo, `fra-core-hub-01` sits in 3 more
  LANs: `partner-a`, `partner-b` (stubs) and `data-sync`, a transit LAN on
  a new Cross Connect `fra-data-sync` to fra-prod-data, where the ETL pair
  joins it (Cross Connects cannot span locations, so a link to fra2-dr was
  not an option). Regenerated with `make fixture`; IDs and IPs changed.
  Tests that counted the hub's NICs (diff: 7 NICs added with it, 9 changes
  in fra-prod-core) and its "4 LANs" reason were updated.
- **Demo now.** fra-prod-core: 31 instead of 34 nodes, 22 instead of 25
  always-drawn edges; the hub shows "7 LANs · +2 LANs only here" and a
  `data-sync` line to the `fra-data-sync` hub. ELK layout (Node, median of
  30) 29.3–29.8 → 26.6–26.9 ms with folding off → on; open → LANs drawn
  in the browser 238–239 → 233–240 ms (7 runs each, alternating; this
  machine was less loaded than in the first step).
- **Real snapshot, counts only.** Per view [boxes without groups, nodes,
  always-drawn edges] before (first step) → after, sorted by before:
  [58,66,31] → same, [36,37,19] → same, [31,33,25] → same, [31,31,30] →
  [15,15,14], [28,30,24] → same, [27,27,26] → [14,14,13], [23,24,34] →
  same, [22,22,25] → same, [20,20,20] → [14,14,14], [20,20,16] → same,
  [15,17,6] → same, [7,7,6] → same, [6,6,5] → same, [5,5,4] → same (2×),
  [3,3,2] → same. In all: 18 stub LANs folded, 17 transit lines; 0 edges
  to missing boxes, 0 anchors to nothing, every LAN has an anchor. ELK
  layout of all 16 views (median of 5 each): 336 → 275 ms in sum, largest
  view 52 → 49 ms.
- **Package 03 hook.** Folding is one map (`folded`: LAN → router box) built
  before the LAN boxes. Expanding a router later means leaving its LANs out
  of that map (e.g. a set of expanded router boxes passed in, like
  collapsed groups): the LANs come back as boxes with on-demand lines and
  `via` markers, without other changes. The "+N LANs only here" button is
  the natural place for the toggle; expansion changes the layout signature
  (new boxes), so it should be part of the diagram input, not of `toFlow`.
