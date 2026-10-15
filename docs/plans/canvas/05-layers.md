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

(fill in when done)
