# 09 Export

**Problem.** The diagram is only usable inside the app. Documentation,
audits and change requests need files.

## Design

Export the current view (contract, datacenter, focus or path) from a menu
in the diagram bar:

- **SVG**: generated from the `Layout` (positions, sizes, edge points) and
  node data, not from the DOM, so it is clean, small and independent of the
  zoom. Own small renderer in `diagram/export.ts`: rects with the kind
  colours, text (escaped), edges as polylines (routed) or cubic curves
  (free), arrow-less like the canvas, legend in a corner, title and snapshot
  date in the footer. Use the light-mode tokens (copy the values from
  `index.css`; an exported file has no CSS variables).
- **PNG**: draw the SVG onto a canvas (`Image` from a `blob:` URL) at 2×
  and save. Check the CSP in `index.html` allows `blob:` images (img-src).
- **draw.io**: an uncompressed `mxfile` XML with one `mxCell` per box and
  edge (styles for kinds; groups as containers), so people can edit it.
- File names: `ionos-<contract>-<view>-<date>.svg|png|drawio`.
- Everything happens in the browser; nothing is uploaded.

## Tests

- `export.test.ts`: SVG of the demo contract view parses as XML, contains
  every datacenter name once, escapes `<`/`&` in names; draw.io XML has
  one vertex per box and one edge per edge, groups as parents.

## Accept

- Browser: download each format for the contract view and one datacenter;
  open the SVG in the browser (looks like the canvas at fit zoom); the
  draw.io file opens in diagrams.net (check by the user; we cannot open it
  here).

## Left over

(fill in when done)
