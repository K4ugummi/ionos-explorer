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

(fill in when done)
