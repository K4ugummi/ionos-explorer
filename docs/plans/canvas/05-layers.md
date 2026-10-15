# 05 Layer switches

**Problem.** Every view shows everything it knows. People looking at
network paths do not need unattached volumes; people checking security do
not need NAT gateways; after a comparison, people want to see only what
changed.

## Design

A "Layers" menu in `.dg-bar` (next to the legend button from package 01)
with toggles:

- Load balancers (NLB/ALB and their target lines)
- NAT and VPN gateways
- Managed services (Kubernetes node pools, PostgreSQL)
- VPN tunnels and manual links (contract and datacenter view)
- Security Groups and unattached volumes (the "leftovers" groups)
- Cross Connect peers (peer datacenter nodes in the datacenter view)

and two emphasis modes (dim everything else, like search does):

- Only appliances (`is:appliance`)
- Only changes (when comparing; `node.change`)

Hidden layers are removed in `build.ts` (pass `layers` in the options
object introduced in package 03), so the layout uses the space; emphasis
modes only dim in `flow.ts` (no re-layout). Persist the choice per viewer
in `localStorage` (`ionos-explorer:layers`), wrapped in try/catch.

The legend only lists what is shown.

## Tests

- Unit: each toggle removes exactly its node/edge kinds from the diagram;
  emphasis modes do not change the diagram (same layout signature).

## Accept

- Browser: toggling a layer re-lays out once and the choice survives a
  reload; "Only changes" with the demo comparison (Changes tab →
  "Compare with the demo two weeks earlier") dims all but the changed boxes.

## Left over

Done 2026-10-15. Notes and deviations:

- **Code.** `layers.ts` (layer list, `hiddenKind`, parse/serialize,
  `loadLayers`/`saveLayers` in try/catch, `emphasized`), `LayersMenu.tsx`
  (button + popover), `dismiss.ts` (`useDismiss`: Escape returns focus to
  the button, pointer down outside and focus leaving close it; the legend
  popover uses it too now). `DiagramOptions.hidden` for
  `datacenterDiagram`, `contractDiagram(model, { hidden })`, and
  `toFlow(..., emphasis)`.
- **Rule.** Hidden resources (NLB/ALB, NAT/VPN gateways, node pools,
  PostgreSQL) are dropped after LAN tiers and folding are worked out, so
  those stay as they were (a LAN does not fold into a router because the
  load balancer next to it is hidden). LAN widths count only shown boxes;
  a router draws its line at rest to a LAN only a hidden resource
  connected. Lines go with their boxes; the internet box, peer datacenters
  and endpoints outside go when only removed lines reached them. So:
  hiding gateways also removes the tunnels drawn from VPN gateways (they
  have no other start), and hiding Cross Connect peers keeps a peer that a
  tunnel or manual link still leads to (fra-prod-core: 4 → 1 peer).
  "Security Groups, unattached volumes" hides all three leftover groups
  (also "Other resources"); the tooltip says so.
- **Contract view.** Only "VPN tunnels and manual links" applies; it also
  removes the "Outside the contract" group. The other switches are shown
  greyed out with a note ("only in a datacenter's diagram"), so the
  stored state stays visible.
- **Emphasis** is a radio group (Everything / Only appliances / Only
  changes), not two checkboxes: both on at once would mean "appliances
  that changed" or "either", neither obvious. "Only changes" is disabled
  without a comparison and a stored "changes" then counts as off. It
  lights the boxes that anchor a model node with `change` (so a changed
  NIC lights its server, a changed member its group) and Cross Connect
  lines that stand for one; nothing gets the search "match" ring.
- **Legend.** Lists only the line kinds the current diagram has (a peer
  line counts as Cross Connect), which covers hidden layers and also drops
  e.g. "VPN tunnel" in a datacenter without tunnels.
- **Bar fit (added).** At 390 px the Layers button overlapped the Legend
  button. The collapsed legend slot now keeps its button's width, the
  breadcrumbs do not wrap and the datacenter name ellipsizes; below 520 px
  the location pill is hidden and the bar gap is 12 px. Measured: 1500 px
  with the drawer open and a comparison: crumbs 414–664, Legend 919–979,
  Layers 991–1046, popover 772–1046 (drawer starts at 1060). 390 px: Legend
  249–309, Layers 321–376, popover 90–376; no horizontal overflow.
- **Tests.** `layers.test.ts`: storage round trip and junk input; for each
  of the 6 layers in all 14 demo datacenters (demo + a site and a manual
  link), the removed node and edge ids are exactly that layer's boxes and
  lines (rule above) and nothing new appears, with something removed for
  each layer; the contract view with each non-`links` layer has the same
  layout signature, with `links` it loses exactly the tunnel/manual lines
  and the outside group; with all layers hidden every anchor and edge end
  exists; emphasis leaves diagram, signature and positions unchanged, marks
  no hits, "Only appliances" in fra-prod-core keeps exactly fw group, fw-01,
  fw-02, hub-01, vpn-01 bright; "Only changes" keeps every changed box.
- **Browser (demo, ELK runs counted by patching `Worker.postMessage`).**
  Unchecking a layer: 1 ELK run each (LB, gateways, managed, peers, links,
  leftovers); emphasis: 0. A layer switched back on in the same page
  reuses the cached layout; after a reload it is laid out once. The old
  drawing stays up while the new layout runs (01 behaviour), so no
  "Laying out…" appears; a view the canvas had fitted is fitted again,
  one the user had moved stays put. Reload kept `{"hidden":["lb"]}` and
  the NLB stayed hidden. Keyboard: Enter on "Layers" opens it with focus
  on the first checkbox, Space toggles, Escape closes and focus returns to
  the button; an outside click closes it. Compare → "Only changes":
  fra-prod-core 29 of 32 boxes dimmed, bright are the two changed boxes
  (hub-01, api-01) and api-01's group; contract view: 6 cards bright, 8
  dimmed. Light and dark, no console errors or warnings, no requests to
  other hosts.
- **Layout time** (Node, ELK bundled, fra-prod-core, median of 30): all
  layers shown 31 nodes / 32 edges 42.0 ms, all hidden 26 / 19 24.0 ms. With
  nothing hidden the diagrams are unchanged (all earlier tests pass).
- **Not done.** A resource in a hidden layer that is selected from search
  has no box, so nothing lights up (the details drawer still opens); a
  hint like "hidden by Layers" could be added. Layer choice is per browser,
  not per contract or in the URL.
