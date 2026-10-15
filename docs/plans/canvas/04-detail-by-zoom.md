# 04 Detail by zoom

**Problem.** At the zoom needed to see all 16 datacenters (or a big
datacenter) at once, subtitles, IPs, pills and edge labels are unreadable
noise and cost rendering time.

## Design

Three levels from the React Flow zoom (`useStore((s) => s.transform[2])`),
applied as a class on `.dg-canvas`, with hysteresis so it does not flicker
at the threshold:

- `lod-near` (zoom ≥ 0.6): everything as today.
- `lod-mid` (0.3–0.6): hide subtitles and IPs, keep titles, tags, pills on
  datacenter cards, edge labels only for `ALWAYS_LABELLED` kinds
  (`flow.ts`).
- `lod-far` (< 0.3): titles only, in a larger font so they stay readable;
  hide pills, tags and all edge labels; group labels stay.

Pure CSS on the classes where possible (no re-render of every node on zoom).
Selected, related and search-matching nodes keep their full detail at every
level (they already carry classes `selected`, `related`, `match`).

## Tests

- Unit: the level function with hysteresis (`lodFor(zoom, previous)`).
- Browser: zoom out step by step on the contract view and screenshot each
  level; check text is either readable or hidden, never overlapping mush.

## Accept

- Contract view of the demo fitted to 1500 × 950: titles readable, no
  subtitles/IPs.
- Zooming does not trigger a re-layout (no "Laying out…") and stays smooth
  (no console warnings).

## Left over

Done 2026-10-15. Notes and deviations:

- **Rule.** `lodFor(zoom, previous)` in `lod.ts`, thresholds `LOD_MID`
  0.6 and `LOD_FAR` 0.3; the current level holds until the zoom is 10 %
  past a threshold (near → mid below 0.545, mid → near from 0.66, mid → far
  below 0.273, far → mid from 0.33). `useLod` in `DiagramView.tsx`
  subscribes to the React Flow store and sets `lod-near|mid|far` on
  `.dg-canvas`; the canvas renders again only when the level changes.
  `lod.test.ts` covers levels, hysteresis, jumps and wobble.
- **Deviation: no hysteresis for views the canvas framed itself.** The
  canvas starts at zoom 1, so with hysteresis the fitted demo contract
  (0.555) stayed `near` and kept its subtitles. While `framing` is set (the
  view is where the canvas put it) the plain level is used; hysteresis
  applies once the user pans or zooms. The framing effects now set
  `framing` before moving the view, so an unanimated fit sees it.
- **What each level shows** (CSS block "detail by zoom" in `App.css`).
  Mid: titles 17 px (cards 20 px), appliance tags (they shrink before the
  title does), card pills (13.5 px, two rows), the router's "N LANs",
  group titles, and the edge labels that are drawn anyway (Cross Connect,
  tunnel, manual link; others only appear at the selection). Hidden:
  subtitles and IPs, "via" pills on LANs, the "+N LANs only here" button,
  group "Collapse" buttons, the card's "Open diagram" button and the kind
  badges of members and cards (they took the room titles needed). Far:
  titles only, 26 px (members and "+N more" 20 px, hubs 24 px, cards 34 px
  on up to two lines), group titles 26/20 px; no badges, tags, pills,
  "N LANs" or edge labels except at the selection. The "+N more" title
  stays at every level. Change bars widen 4 → 8 → 16 px (with matching
  left padding), a card's "+2 ~5 −1" pill stays at far (20 px), router
  bars and LAN bars get thicker at far.
- **Full detail** comes from a `full` class on boxes that are selected,
  related or search hits (`render.tsx`), plus `:focus-visible` on the
  React Flow node. Buttons are hidden with a clip (not `display: none`):
  with `display: none` Tab from a card to its "Open diagram" button lost
  focus to `<body>`, because the button vanished as the card lost focus.
  Now Tab onto a card at mid/far shows its details, the next Tab reaches
  the button, Enter opens the datacenter (checked in the browser).
- **Edge labels** carry `hl` (`FlowEdgeData.hl`, tested in
  `diagram.test.ts`), so lines at the selection keep their label at far.
- **Browser (demo, 1500 × 950).** Contract fitted: zoom 0.555 → `lod-mid`,
  titles readable (~11 px on screen), no subtitles/IPs. fra-prod-core
  fitted: 0.595 → mid. Wheel zoom on both through 1 → 0.45 → 0.2 → 1
  passed near/mid/far and back; "Laying out" was shown 0 times (mutation
  observer), no console errors or warnings, no requests to other hosts,
  light and dark. With a comparison loaded, the 2 change bars in
  fra-prod-core stay visible at every level. A selected router at far
  keeps its subtitles and "+2 LANs only here", its 5 related boxes keep
  their subtitles, its 5 line labels stay; search hits keep their IPs.
  At 390 px the fitted views are at zoom 0.17–0.18 (`far`), no
  horizontal overflow.
- **Honest limits.** Below ~0.25 zoom titles are about 5–6 px on screen:
  hidden mush is gone, but they are not really readable (boxes are too
  small for larger type). That is every fitted view at 390 px. Near the
  bottom of `mid` (contract with the drawer open fits at 0.31) the card
  pills are tiny. The selected box keeps its normal small type at far, as
  the plan asks, so it can be less legible than its neighbours.
  Layout code is untouched, so layout times are unchanged.
