# 06 Lines between locations

**Problem.** In `contractDiagram` datacenters are grouped by location. ELK
lays out each group separately (`layout.ts`, SEPARATE_CHILDREN), so lines
between datacenters in different locations (Cross Connects with peers in
several locations, VPN tunnels, manual links) have no route and are drawn
as long free curves that cross other cards.

## Options (spike first, decide with numbers)

1. **ELK hierarchical layout.** `elk.hierarchyHandling: INCLUDE_CHILDREN`
   on the root so ELK routes edges across group borders orthogonally.
   Risk: layout time on large contracts. Measure with `scale.test.ts`
   (240 datacenters) and the demo; acceptable if the large case stays
   within the current test budget and the demo under ~300 ms.
2. **Two-level layout with bundling.** Keep per-group layout. Replace edges
   between locations by one edge per location pair between the group boxes
   ("3 links", label lists kinds), laid out at the root level (groups as
   sized nodes in a second ELK pass, or reuse the root layout which already
   places groups). Selecting the bundle or one of its datacenters draws the
   individual lines on demand.
3. **Ports.** Give each location group ports on its border (ELK
   `portConstraints`) and route datacenter → port inside, port → port
   outside.

Recommendation going in: try 1; if too slow, do 2 (it also reads better
at a glance with 16+ datacenters).

## Tests

- Unit: in the demo contract view, every edge between datacenters in
  different locations has points (option 1) or is represented by a bundle
  edge between location groups (option 2), and no inter-location edge is
  left without either.
- `scale.test.ts` within budget; report layout times before/after.

## Accept

- Browser: demo contract view has no line crossing a datacenter card that
  is not one of its ends (check visually in screenshots at fit zoom).

## Left over

Done 2026-10-15. Notes and deviations:

- **Decision: option 1, but only for linked locations.** Plain option 1
  (the whole contract as one INCLUDE_CHILDREN graph) routes every line, but
  ELK cannot pack components or wrap layers in that mode, so datacenters
  nothing connects line up in one row: the 240-datacenter scale contract
  became 65132 × 388 (aspect 168, the test wants < 4), the real snapshot
  4028 × 900 (aspect 4.5, before 2556 × 1248). It also crashed with
  `considerModelOrder` (ELK internal TypeError). What was built instead:
  `Diagram.linkedLayout` (set by `contractDiagram`) makes `layoutDiagram`
  put only the top-level boxes that lines across groups join
  (`linkedBoxes`, a union-find over those lines) into an invisible box laid
  out as one layered graph (INCLUDE_CHILDREN, `LINKED` = the layered options
  without model order and component packing); its groups use the same
  options with their own padding. The root stays rectpacking, the linked
  box takes the place of its first member, and locations no line joins keep
  their own layout exactly (tested). Lines between groups are handed to ELK
  from the earlier group to the later one and the route is reversed back
  afterwards; without that, the manual link fra-prod-core → txl-prod-core
  pointed against the tunnel fra-mgmt → txl-prod-core and looped round both
  locations. Option 2 (bundles) was not needed: every line keeps its own
  route and label, and selection, search, emphasis and the layer switch
  work on the lines as before.
- **Numbers (Node, ELK bundled, median).** Demo contract (with the demo
  links): 24–33 ms before → 26–33 ms after (31 runs, two alternating
  rounds; cold, 15 runs: 42 → 65–70 ms). Scale contract without lines
  between locations: unchanged (no linked box; 172–233 vs. 229–274 ms,
  noise). Scale contract with 40 manual links and 2 Cross Connects across
  locations (new test): 174–226 ms with the lines unrouted → 238–383 ms all
  routed, 10312 × 3422 (aspect 3.0). `scale.test.ts`: 1.05 s and 0.62 s,
  budget 60 s.
- **Real snapshot (counts only).** All 16 datacenters are in one location
  and it has no tunnels or links, so 0 lines between locations, before and
  after: the layout is identical (2556 × 1248, 23 edges, 0 without points).
  With a site and 1 / 3 links added in the test only: 1 / 3 lines between
  locations, 1 / 3 without points before, 0 after; 0 routes through a box
  that is not one of their ends; 2345 × 1434 and 2837 × 1454; 51 / 70 ms.
- **Demo in the browser** (1500 × 950, fit; lines checked against every
  box on screen by sampling the SVG paths): before 4 of 15 lines crossed
  boxes that are not their ends (tunnel fra-mgmt → Head office over 5
  boxes, tunnel fra-mgmt → txl-prod-core over 3, manual fra-prod-core →
  txl-prod-core over 2, manual lhr-prod-edge → Head office over 1); after
  0 of 15, light, dark and 390 px. Fit zoom 0.555 → 0.501 (the linked
  locations take a bit more room). Cross Connect hubs inside de/fra and
  de/txl look as before. Search dimming, selection framing (fra-mgmt from
  search, centred at 0.7), a clicked tunnel highlighted with its label at
  every zoom level, the links layer (10 lines, no outside group, the old
  layout; back on: 15 lines, 0 crossings), and the change pills on cards when comparing
  (layout reused, 0 crossings) all work; no console messages, no requests
  to other hosts. Screenshots: `shots06/before-*.png`, `after-*.png`.
- **Limits.** In a linked box, datacenters of a location that nothing
  connects sit side by side in one row (no component packing), so a big
  location with one tunnel gets wider than before; the synthetic
  240-datacenter case with 40 random links is aspect 3 and busy, where
  bundling (option 2) would read better. Routes in a linked box may cross
  a group's title strip. Layout times stay far below the budget, so the
  linked layout is not switched off for large contracts.
