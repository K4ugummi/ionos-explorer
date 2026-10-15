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

(fill in when done)
