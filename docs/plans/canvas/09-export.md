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

Done 2026-10-15. Notes and deviations:

- **Code.** `diagram/export.ts`: `exportSvg`, `svgToPng`, `exportDrawio`,
  `exportFileName`, `saveFile`, plus the pieces they share
  (`exportScene`, `edgeShape`, `legendItems`, `textWidth`/`fitText`,
  `xml`, `mix`, `TOKENS`, `pngScale`). `diagram/ExportMenu.tsx`: the
  "Export" button and its popover (SVG image, PNG image, draw.io file),
  next to "Layers". `DiagramView` hands it the layout as drawn and an
  `ExportInfo` (title as in the crumbs, view name for the file, contract
  number, snapshot time, the compared snapshot's time). `flow.ts` exports
  `ALWAYS_LABELLED`. `test/xml.ts`: a small strict XML parser for the tests
  (Node has no DOMParser; no new dependency).
- **What is exported (decisions).** Exactly the layout the canvas draws:
  the same `Layout` object after `withData` and `applyPositions`, so own
  positions (08), dropped routes of moved boxes (drawn as the same smooth
  steps, `getSmoothStepPath` with radius 8), unrouted lines as the same
  React Flow bezier curves between the same handles (`handles`), hidden
  layers (05), collapsed groups, "+N more" boxes and folded router LANs
  (02/03) all come out as on screen. A selected server that a collapsed
  group shows only because it is selected stays (it is a box of the
  layout). Left out on purpose: the selection ring and its "related"
  highlight, search hits and dimming, the emphasis dimming of "Layers"
  (05; it is a way of looking, like search), lines drawn only while
  something is selected (router LANs, balancer targets), and buttons
  ("Open diagram ›", "Collapse", "fold LANs again", the peer's ↗).
  Kept: the comparison's change bars, the "+2 ~5 −1" pills on cards and
  "New / Changed since" in the legend, with "compared with …" in the
  footer; they describe the content, not the viewer's state. The focus
  outline of focus and path views stays (it says what the view is about).
  Detail is always the near level (04), whatever the zoom. Checked: with
  a selection and a search the contract SVG is byte-identical to the one
  without; in dark mode it is byte-identical to light.
- **SVG.** One file, no CSS, no external references (`<style>`, `<image>`,
  `href` are not used; tested): attributes only, light colours copied
  from `index.css` (`TOKENS`; a test reads `index.css` and fails if they
  drift), `color-mix` worked out in `mix`. Groups first, then lines, then
  boxes, then line labels on top. Boxes are drawn like their CSS: kind
  badges, titles bold, subtitles, appliance tags, the "not running" dot,
  the card's "internet" marker and pills (one row, as many as fit), LAN
  bars with the "via" marker and right-aligned subtitle, router bottom
  bar, "N LANs · +N LANs only here", hub and internet pills with the
  globe, dashed peers/externals/"+N more", change bars clipped to the
  rounded box (`clipPath`). Footer below the picture: title (as in the
  breadcrumbs), "Contract … · snapshot YYYY-MM-DD HH:MM UTC · IONOS
  Explorer", and the legend (only the line kinds drawn, like the
  canvas). The picture is moved so that boxes dragged to negative
  coordinates still land inside (tested).
- **Fonts.** `Arial, Helvetica, 'Liberation Sans', 'Nimbus Sans',
  sans-serif` and a monospace stack for group titles and member IPs, fixed
  sizes (the near-level CSS sizes). Text cannot be measured without a DOM,
  so widths are estimated from Arial/Helvetica glyph widths (+3 %), which
  all those fonts share; long text is cut with "…" to its box. Measured in
  Chromium with the real fonts on the exported files: 0 texts overflow
  their box in any of the 8 demo exports. The app's own system-ui font is
  not used: its widths differ per system. Whitespace at the ends of a text
  is dropped by SVG, so the " · " in the router line is placed by hand.
- **Escaping.** Every text goes through `xml()`: `& < > " '` escaped, and
  characters XML 1.0 forbids (control characters, lone surrogates,
  U+FFFE/U+FFFF) become U+FFFD, so a name with any characters still gives a
  file that parses (tested with `a<b & "c" 'd' \u0001 é 🙂`). draw.io
  labels are HTML (`html=1`), escaped as HTML and then again as an
  attribute. Model ids never go into the files (tested); draw.io cell ids
  are `n1…`, `e1…`.
- **PNG.** The SVG as a `blob:` image drawn on a canvas at 2×
  (`pngScale` lowers it for pictures over 50 Mpx or 32000 px a side, e.g.
  the 240-datacenter scale contract would be 1.19×), `toBlob`. The CSP
  already allowed it (`img-src 'self' data: blob:`); nothing was changed.
  Checked against a production build (`vite preview`, CSP meta present):
  0 `securitypolicyviolation` events, PNG 2× as expected.
- **draw.io.** Uncompressed `mxfile`: layer "Diagram" with one vertex per
  box (groups `container=1`, their children placed relative to them) and
  one edge per line drawn; a second layer "Title and legend" with one text
  cell. Routed lines: `edgeStyle=none` through ELK's bend points, with
  exit/entry points where ELK put the ends, so the route is exactly the
  canvas's; an edge belongs to the innermost group holding both ends
  (points in that group's coordinates), so it moves with the group when
  edited. Lines without a route: `orthogonalEdgeStyle` (curved like the
  canvas, or right-angled for a moved box's line) from the same sides.
  Kind styles: LAN fill and colour, hub and internet as pills, dashed
  peers/externals/"+N more"/server groups, router edge colour; a change
  is a coloured 2 px border (draw.io has no inset bar), the focus a blue
  2 px border. Not opened in diagrams.net here; to be checked by the user.
- **File names.** `ionos-<contract>-<view>-<date>.<ext>`, the date being
  the snapshot's (what the picture shows), the view `contract`, the
  datacenter's name, `focus-<name>` or `path-<from>-to-<to>`. Only
  `A–Z a–z 0–9 . _ -`: accents dropped (NFKD), everything else a dash, runs
  collapsed, the view cut to 80 characters, no leading dots; without a
  contract number the part is left out (tested, including `../../etc`).
  Saved with `a[download]` on a `blob:` URL, revoked a second later.
- **Menu.** Like "Layers": `useDismiss` (Escape returns focus to the
  button, a click outside or Tab past the end closes it), Enter on the
  button focuses "SVG image", ↑/↓ move between the formats, Enter saves;
  after saving the menu closes and focus is back on "Export". While a PNG
  is drawn the item reads "Saving PNG image…" and the items are disabled;
  an error (canvas too large) is shown in the popover. Below 520 px the
  button is only its icon and "Reset layout" reads "Reset" (accessible
  names unchanged), so the bar still fits.
- **Bundle.** Main chunk unchanged (468.01 kB); the export code is part
  of the lazy diagram chunk: 213.9 → 237.0 kB (69.3 → 77.7 kB gzip).
- **Tests.** `export.test.ts` (13): the demo contract SVG parses, has
  every datacenter card title once, footer and legend, all text inside the
  picture, no ids, no CSS or external references; escaping in SVG and
  draw.io (`xml()` on its own too); draw.io for the contract and
  fra-prod-core: vertices = boxes, edges = lines drawn, children parented
  to container groups with relative geometry, routed waypoints in the
  parent's coordinates, unrouted without, title layer; own positions (a
  card 400 px down in SVG, its lines without waypoints and not curved; a
  card moved far up-left stays inside); hidden layer (NLB gone), collapsed
  and expanded shop-web ("+6 more" / shop-web-12), router "7 LANs" and
  "+2 LANs only here"; on-demand lines left out, nothing dimmed; change
  bars = changed boxes, legend and card counts when comparing; focus and
  path views (one and two focus outlines); text cutting (surrogate pairs
  kept whole, combining marks zero width); colours = `index.css`; file
  names; PNG scale. 181 → 194 tests; `make test` passes (oxlint 0
  warnings).
- **Browser (demo, 1500 × 950).** Downloads via the menu for the contract
  view, fra-prod-core, fra-prod-shop, the focus on fra-core-fw-01 and the
  path fra-core-web-01 → pg-orders-prod, plus the contract with fra-lab
  dragged, the contract and fra-prod-core while comparing. Each file
  checked in the page: SVG and draw.io parse (DOMParser), every draw.io
  parent, source and target exists, every vertex has a numeric geometry,
  PNG exactly twice the SVG's size, 0 texts overflowing. Sizes and times
  (click to download event): contract 2069 × 1528, SVG 26 kB in 40 ms, PNG
  4138 × 3056 729 kB in 1.2 s, draw.io 25 kB in 38 ms (27 vertices, 15
  edges, 10 with waypoints, 7 containers); fra-prod-core SVG 25 kB, PNG
  556 kB in 1.1 s, draw.io 30 kB (33 / 23); fra-prod-shop 13 / 305 / 16 kB;
  focus 23 / 556 / 28 kB (32 / 20); path 885 × 1232, 14 / 289 / 19 kB
  (18 / 19). Load
  balancers hidden: the NLB is not in the file; shop: "+6 more", no
  shop-web-12. Side by side with the canvas (`shots09/side-*.png`) the
  files show the same picture at full detail. Keyboard as described
  above. Dark mode: the canvas and menu are dark, the file is the light
  one (byte-identical). 390 px: Legend 120–269, Layers 281–336, Export
  (icon) 348–380, menu 100–380; with "Reset" 331–380 and the crumb
  "All datacenters" whole; focus view: crumbs 10–99 (the mode title
  ellipsizes, as in 07), no horizontal overflow. 1500 px with the drawer:
  Export 972–1046, menu 766–1046, drawer from 1060. No console errors or
  warnings, no requests to other hosts.
- **Real snapshot (counts only; files deleted right after measuring).**
  Contract view: 33 boxes, 23 lines (19 with waypoints), 2584 × 1378, SVG
  30 kB built in 1.3 ms, draw.io 32 kB in 1.1 ms, 13 of 152 texts cut;
  PNG 5168 × 2756, 811 kB, 1.2 s in the browser. Largest datacenter view:
  66 boxes, 31 lines, 8527 × 724, SVG 42 kB in 1.5 ms, draw.io 52 kB in
  2.4 ms, 3 of 194 texts cut; PNG 17054 × 1448, 836 kB, 1.3 s. Both files
  parse, vertices = boxes, edges = lines. No console errors, no requests
  to other hosts.
- **Limits.** Text widths are estimates: with a font that is not
  metric-compatible with Arial (no Arial, Helvetica or Liberation Sans
  installed) names may come out a little shorter or longer than their box.
  Text is cut where the canvas would cut it, so long names lose their end
  in the files as on screen (no tooltips in a file). The PNG uses the
  fonts of the browser that draws it. Very wide views stay very wide (the
  real 66-box datacenter is 8527 px wide); there is no page splitting or
  fit-to-A4. draw.io: change markers are a border, not a bar; lines without
  a route are drawn by draw.io's own router, so they may differ a little
  from the canvas; HTML labels lose the pill shapes (pills are a "·"
  list). The legend in draw.io is one text cell, not drawn lines. Not
  checked in diagrams.net, Inkscape or Illustrator here.
- **Not done.** Exporting several views at once; a PDF; choosing the
  scale or a transparent background for PNGs; exporting the path steps
  as text.
