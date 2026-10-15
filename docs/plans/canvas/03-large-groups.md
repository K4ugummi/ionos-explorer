# 03 Large groups

**Problem.** Servers with the same name stem and LANs are grouped
(`grp:<stem>|<lans>` in `datacenterDiagram`), but a group shows every
member. A datacenter with 54 servers renders 54 member boxes; with several
large groups the view is mostly server boxes and the network structure
disappears.

## Design

- A group with more than `GROUP_LIMIT` members (8) is drawn **collapsed**:
  the first `GROUP_PREVIEW` members (6), sorted by name, plus a member-sized
  box "+18 more" (`type: 'more'`, new node type, ref = group id).
- Clicking "+N more" expands the group. Expansion state lives in the canvas
  (per diagram key, `Set<groupId>`), is part of the diagram's input (pass
  `expanded` to `datacenterDiagram` via an options object) and therefore of
  the layout signature (see package 01), so expanded and collapsed layouts
  are cached separately.
- **Never hide what matters.** A member is always shown, even when
  collapsed, if it is selected, matches the current search, is an appliance,
  or (when comparing) is added/changed. Those count against the preview,
  and the "+N more" count is what remains.
- The group header keeps the full count ("web · 24 servers · Cube"); the
  "+N more" box says e.g. "+18 more · 2 matches" when hidden members match
  the search, and expands on click.
- Selecting a hidden member from search or a link (`App.tsx` navigate →
  `diagramFor`) must show it: since selected members are always shown, this
  follows from the rule above; make sure the canvas then frames it.
- A "Collapse" action on an expanded group (small button in the group
  header) returns it to the preview.

## Tests

- Unit (`diagram.test.ts`, synthetic model with a 30-server group): 6
  members + a `more` node with the right count; expanded → 30 members, no
  `more` node; a selected/matching member outside the first 6 is included
  and the count drops accordingly; anchors of hidden members point to the
  `more` node (so search highlighting and framing land somewhere sensible).
- Layout signature differs between collapsed and expanded.

## Accept

- Browser: demo has no group > 8; add one in a test model, or temporarily
  check with the scale model. At minimum a unit-tested build plus one
  browser check on a model that has a large group (the fixture may get a
  `web` group of 12 in a lab datacenter if needed, keep the demo realistic).
- Real snapshot (counts only): largest datacenter view goes from 66 boxes to
  how many at rest (print numbers only).

## Left over

Done 2026-10-15. Notes and deviations:

- **Rule.** `GROUP_LIMIT` (8), `GROUP_PREVIEW` (6) and `preview()` in
  `build.ts`. Pinned members (selection, appliances, `change` set) are
  always shown and take room from the preview; if they fill it, all of
  them are shown plus the rest as "+N more". A "more" box never stands for
  one member (9 members with 8 pinned: all 9 drawn). The "more" box is a
  child of the group (`more:<groupId>`, type `more`, member size, last in
  the group); it has no `ref`, the group id is its `parent`.
- **Selection.** `datacenterDiagram(model, dcId, { expanded, selected })`.
  A selected NIC or volume pins its server. Because pinned members take a
  preview slot, selecting a hidden member swaps it for the 6th preview
  member and the group keeps its size (tested with ELK: same group width and
  height), so the rest of the view does not move. The diagram is rebuilt on
  every selection in a datacenter view, but the signature only changes when
  a hidden member comes in, so other selections reuse the layout.
- **Search vs. layout.** Search matches never go into the diagram, so
  typing never lays a view out again. Hidden members, their NICs and
  volumes are anchored to the "more" box, which lights up as a match and
  shows "+6 more · 3 matches" (members with a hit, via `Diagram.hidden`:
  NIC/volume → member, so a server and its boot volume count once). Enter
  in the search or a link selects the hit, which then is shown (selection
  rule) and framed. This deviates from "matching members are always shown":
  with a query like `shop` every member matches and the group would never
  collapse, and each keystroke could relayout.
- **Framing.** Opening or closing a group (or router) keeps that box in view
  once laid out (zooming out only if it does not fit). The "bring the
  selection into view" effect now runs once per selection (`brought` ref):
  before, any new layout of the same view (now: expanding a group) re-centred
  on an off-screen selection the user had panned away from. A revealed
  member gets its target only when its layout is there, then is framed.
- **Expansion state** lives in `Canvas` (`opened`: view key → set), lost when
  the Diagram tab is left (component unmounts); not in the URL.
- **Added (not in the plan):** the same collapse applies to the leftover
  groups ("Unattached volumes", "Security Groups", "Other resources"), with
  "Show all N resources" on the box. That is the only change on the real
  snapshot (see below). Load balancer targets hidden in a group get one
  on-demand line to the "more" box.
- **Router "+N LANs only here" (package 02 hook): done**, it fell out of
  the same `expanded` set. The key is `lans:<router box>` (so a router group
  > 8 can be expanded and unfolded independently). Unfolded, the router's
  stub and transit LANs are boxes again (lines drawn always, transit LANs
  to their Cross Connect), and the button reads "fold LANs again" (no count:
  transit LANs come back too). The button no longer selects the router;
  the router's details still list its LANs when it is selected.
- **Fixture.** `shop-web` in fra-prod-shop grows from 6 to 12 Cubes (a web
  farm behind the ALB): 75 servers instead of 69. `make fixture` regenerated
  both demo snapshots and the annotations. Tests updated: servers 69 → 75
  (`model/build.test.ts`), ALB targets 6 → 12, `type:cube` hits 23 → 29
  (`search/search.test.ts`). Go tests and the diff tests pass unchanged
  (history does not touch the shop).
- **Demo now.** fra-prod-shop: 20 nodes collapsed vs. 25 expanded
  (shop-web: 6 + "+6 more" vs. 12). ELK in Node, median of 30, alternating:
  16–21 ms either way (rectpacking a group is cheap). `scale.test.ts` now
  lays out both groups of 200 collapsed (6 + more) and expanded; ~1.9 s.
- **Real snapshot, counts only.** It has no server group above 8 (sizes
  8, 7, 7, 7, 5, 4, 3, 2 ×8), so server-group collapsing changes nothing
  there: the largest view stays at 66 nodes (58 boxes). The one leftover
  group (16 Security Groups) collapses: that view goes from [36 boxes, 37
  nodes] to [27, 28]. All other 14 views unchanged. Lowering `GROUP_LIMIT`
  to 7 would only collapse the group of 8 (6 + "+2 more", one box less),
  so the plan's 66 → fewer does not come from groups in this contract.
- **Not done.** No "expand all"/"collapse all"; expansion is not saved in
  the URL or across tabs. The "more" box has no keyboard focus ring of its
  own beyond the browser default on its button.
