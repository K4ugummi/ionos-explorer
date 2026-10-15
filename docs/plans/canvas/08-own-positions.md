# 08 Own positions

**Problem.** The automatic layout is good but never exactly how a team
draws its network. People want to move a box and find it there next time.

## Design

- Enable dragging (`nodesDraggable`) for top-level boxes and groups (not
  members inside a packed group).
- Store offsets per view and node in the annotations (new list
  `positions: [{ view: diagramKey, node: id, dx, dy }]`), relative to the
  ELK position, so a re-layout with new resources keeps the user's
  intention roughly. Same storage, export/import and merge rules as links
  and IP corrections (`annotations/annotations.ts`); parse defensively.
- Edges attached to moved boxes: routed edges lose their ELK points and are
  drawn as smooth step edges (`RoutedEdge` already falls back when there are
  no points).
- "Reset layout" button in the diagram bar when the view has own positions.
- Positions apply after layout (`withData`/`applyPositions`), so they are
  not part of the layout signature.

## Tests

- Annotations: parse/serialize/merge of positions; unknown views/nodes are
  kept but ignored.
- Applying positions moves exactly the given nodes and drops route points
  of their edges.

## Accept

- Browser: drag a datacenter card, reload, it is still there; export the
  annotations file and import it in a fresh browser profile → same
  position; "Reset layout" restores the automatic one.

## Left over

Done 2026-10-15. Notes and deviations:

- **Code.** `diagram/positions.ts` (`movable`, `applyPositions`, `offsetTo`,
  `padding`); `positions: [{ view, node, dx, dy }]` in
  `annotations/annotations.ts` (`setPosition`, `resetPositions`,
  `positionsOf`, parse, serialize, merge, `isEmpty`); in `DiagramView.tsx`
  the offsets of the view (stored + the one being dragged) go on the layout
  right after `withData`, `onNodesChange` follows and stores drags, "Reset
  layout" / "Undo reset" in the bar; `toFlow(..., draggable)`, `handles`
  and `PlacedEdge.moved` in `flow.ts`/`types.ts`, four side handles and a
  smooth step path for moved lines in `render.tsx`; a "Box positions" line
  with "Reset all" on the Overview; `App` leaves positions out of
  `applyAnnotations`.
- **What moves.** Top-level boxes and groups, and boxes inside a group that
  ELK lays out as a graph: datacenter cards and Cross Connect hubs in a
  location. Not members of a packed group (servers in a server group,
  leftover groups, endpoints in "Outside the contract", hubs in "Unused
  Cross Connects") nor "+N more": a drag there pans the canvas, the group
  is dragged by its frame. Rule: not `member`/`more` and the parent is not
  `rectpacking` (tested on the demo contract and fra-prod-core).
- **Groups follow their contents (added).** A card dragged out of its
  location would otherwise sit outside its frame. A group with a moved box
  inside is drawn around its contents plus its ELK padding (kept routes
  inside it count), so it grows when a card leaves and shrinks when cards
  are stacked tighter; ELK's group size equals that box (checked: moving a
  card by 1 px changes the group by at most 1 px), so nothing jumps.
  Offsets nest: a card moved inside a moved location moves by both.
- **Lines.** Plan: routed lines of a moved box lose their points. Built:
  a line keeps its route, shifted, when both ends moved by the same amount
  (both inside a moved location or server group) and loses it otherwise
  (`moved`). Such lines are drawn as React Flow smooth steps (radius 8)
  between the sides that face each other (`handles`: top/bottom as before,
  or left/right when the horizontal gap is wider; new `left-*`/`right-*`
  handles), not as the curves `RoutedEdge` falls back to, so they still look
  orthogonal. Other lines keep their routes even if a moved box now lies
  on them (lines between cards in a location are drawn above the cards,
  as before).
- **Storage.** Per view = the diagram key (`contract`, `dc:<id>`) and
  diagram node id (`loc:de/fra`, `grp:<stem>|<LANs>`, `cc:<id>`,
  `peer:<id>`, resource ids). Those keys are wider than resource ids, so
  they are checked for length (≤ 500) and control characters instead of
  the `ID` pattern; dx/dy must be finite, |v| ≤ 10⁶, are rounded, 0/0 is
  dropped, the last entry for a box wins, at most 20000 entries. Merge key:
  view + node, the imported file wins (like links by id). Unknown views and
  boxes are kept and ignored, also when a key disappears: a collapsed or
  regrouped server group (the key holds its LANs), a folded LAN, a hidden
  layer, a deleted resource, a server that joined a group (it is a member
  then, and members do not move). The file stays version 1 (older files
  load with no positions; older apps drop the field). Positions alone keep
  the stored annotations (`isEmpty`) and the export button.
- **No re-layout, no new model.** Offsets are applied after the layout
  (not in the signature, tested), and `App` memoizes the applied model on
  sites, links and IP corrections only, so a drop does not rebuild the
  model, search, paths or diagrams. Browser: 0 ELK runs during and after a
  drag, a reset, an undo, and when comparing with moved boxes. Opening a
  "+N more" in a moved group lays the view out once (it is a new box) and
  the group keeps its offset from its new automatic place (it moved by
  −102 px with it, as ELK placed the wider group differently).
- **Drag is not a click.** `selectNodesOnDrag` off (a drag never selects),
  `nodeDragThreshold` and `nodeClickDistance` 4 px: clicks shaking by 0–3
  px still select (checked 0, 1, 2+1, 3+2 px), a drag of 6 px neither
  selects nor moves visibly. React Flow drags the selected box along with
  the one held; only the held one moves (`onNodeDragStart`), checked:
  fra-mgmt selected, fra-lab dragged, fra-mgmt stays. Each node gets
  `measured` from its fixed size; without it React Flow warned "trying to
  drag a node that is not initialized" on every drag.
- **Decisions.** Focus and path views: no dragging, no reset button (they
  are built per question, rebuilt with each selection, fitted whole, keyed
  by hops and orientation, and their boxes share ids with the datacenter
  views). The linked contract layout (06): nothing special, offsets go on
  its result; lines between locations lose their routes when one end
  moves. Layers (05): a hidden box's offset waits; the button counts stored
  entries of the view, so it can show while every moved box is hidden.
  Detail by zoom (04): untouched (drags work at 0.056, lod-far). Search and
  selection framing, the minimap, fit and refit use the moved positions.
  Reset refits a view the canvas had framed. Undo: "Reset layout" turns
  into "Undo reset" until the next move in that view (cheap insurance
  against a misclick).
- **Keyboard.** Free with React Flow: Tab to the selected box, arrow keys
  move it 5 px (Shift: 20 px), each press is stored. Unselected boxes do
  not move with the arrows (React Flow only moves selected ones). Groups
  are not selectable, so they cannot be moved by keyboard.
- **Touch.** With a coarse primary pointer (`(pointer: coarse)`), only the
  selected box is draggable: a finger on any other box pans the canvas as
  before, tap selects, then a drag moves it. Mouse at 390 px drags as on a
  desktop.
- **Tests.** `positions.test.ts` (11): exactly the moved box changes and
  its lines lose their routes; a moved group takes its cards and shifts the
  routes inside; groups drawn around moved contents (narrower and taller,
  grown up and left, nested offsets); unknown, non-movable and zero offsets
  ignored (same layout object); `offsetTo` round trip including a grown
  group; `padding`; on the demo: what is movable in the contract and
  fra-prod-core, a card moved 400 px with every other box and route
  unchanged, a server group with its members, offsets on a cached layout
  through `toFlow` (draggable only with the set); `handles`.
  `annotations.test.ts` (+5): set/replace/forget/reset/positionsOf, model
  untouched, file round trip with junk and the last-wins rule, merge,
  stored without links. `scale.test.ts` (+1): one drag frame (apply + toFlow)
  on the 240-datacenter contract, median under 50 ms (measured 0.9 ms).
  164 → 181 tests; `make test` passes (oxlint 0 warnings).
- **Browser (demo, 1500 × 950).** Accept: fra-prod-core dragged 200 px
  down at zoom 0.501 → stored `contract` 0/385 (the 4 px threshold eats
  the first move event, so 385 of 399), hash unchanged, 0 ELK runs, 4 of
  15 lines lost their routes; reload: same place, fra-mgmt unchanged;
  exported file imported in a fresh browser context: "Imported 2 links, 1
  sites, 1 IP corrections and 1 box positions", card at 975/621 (automatic
  975/236), same as in the first context; "Reset layout" → back at
  975/236, 0 ELK runs, stored 0, "Undo reset" → back at 621, reset again.
  fra-prod-core view: server group fra-core-web moved 427/66 with its
  members, a LAN −328/0 (5 of 23 lines lost routes), a member drag panned
  the canvas 80/60 instead; keyboard on fra-core-nlb: Shift+→ ×2, ↓ =
  40/5, still selected. Focus on fra-core-fw-01: 0 draggable boxes, no
  reset; back: reset shown, 11 draggable. Search "fra-lab" after moving it
  centres it where it is now. Comparing: fra-lab stays, 0 ELK runs, 6
  change pills. Touch (390 × 844, mobile, coarse): 0 draggable boxes
  before selecting, a finger on a card panned 60/80, tap selected it (1
  draggable), a finger drag moved it 223/0 without panning. Bar at 390 px:
  crumbs 14–112, Legend 124–210, Layers 222–277, Reset layout 289–376, no
  horizontal overflow; with the drawer open at 1500: Reset layout 959–1046,
  drawer from 1060. Light and dark, no console errors or warnings, no
  requests to other hosts. Screenshots: `shots08/own-contract-*.png`,
  `own-dc-*.png`, `own-contract-selected-dark.png`, `phone-light.png`,
  `overview-positions-light.png`.
- **Real snapshot (counts only).** Contract: 33 boxes, 26 movable, 23
  routed lines; largest datacenter: 66 boxes, 32 movable, 31 routed lines.
  Moving every movable box at once: 0 boxes misplaced, apply + toFlow 3 ms;
  one drag frame median 0.2 ms (contract) and 0.4 ms (datacenter).
- **Limits.** No collision handling: a box can be dropped onto others, and
  a location dragged over another overlaps it. Lines that kept their route
  can run across a box moved onto them. A moved line is a plain step
  between two sides; it can cross other boxes (ELK is not asked again).
  Offsets are relative to the automatic place, so when a new resource
  shifts the layout, moved boxes shift with their automatic place (the
  plan's intent), and two boxes placed side by side may drift apart.
  Positions are per browser and file, not per user; two people importing
  each other's files get the last import's position for a box. In headless
  Chromium, a faint trail of the dot background stayed where a dragged
  group had been until the next repaint (gone after a pan or reload);
  likely a software-raster artifact, not checked in a GPU browser.
- **Not done.** Snap to grid; moving several boxes at once (selection
  rectangle); moving members within a packed group; dragging groups with
  the keyboard; own positions in focus and path views; asking ELK to route
  the lines of moved boxes again (would make a drop lay the view out).
