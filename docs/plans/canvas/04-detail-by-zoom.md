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

(fill in when done)
