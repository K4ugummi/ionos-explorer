# Canvas improvements: plan

How to make the diagram (the "canvas") readable and fast for real
contracts. Each work package is its own file, written so it can be picked
up without any earlier conversation: read this file, then the package.

## Status

Work through the packages in order; tick them off here when done.

- [x] [01 Quick wins](01-quick-wins.md): layout cache, refit on resize, legend, lazy loading
- [x] [02 Servers in many LANs](02-many-lan-routers.md): no more fans of 16 lines
- [x] [03 Large groups](03-large-groups.md): collapse server groups beyond 8
- [x] [04 Detail by zoom](04-detail-by-zoom.md): names only when zoomed out
- [x] [05 Layer switches](05-layers.md): show/hide kinds of things
- [x] [06 Lines between locations](06-contract-routing.md): no curves across cards
- [ ] [07 Focus and path view](07-focus-and-path.md): what is connected, and how A reaches B
- [ ] [08 Own positions](08-own-positions.md): drag boxes, keep them
- [ ] [09 Export](09-export.md): SVG, PNG, draw.io

01–03 fix what is most visible with real data and come first. 07 is the
largest feature and the most valuable after that.

## Why: what a real contract looks like

Measured on a real contract (counts only, no names): 16 datacenters in a
few locations, 177 servers, 241 NICs, 24 Cross Connects (7 unused, 4 with
one LAN). The largest datacenter view has 66 boxes. Several servers sit in
7, 8 and 16 LANs (routers/firewalls): today each draws one line per LAN, so
one server fans 16 lines across the view. The synthetic demo
(`make fixture`, 14 datacenters, 75 servers) is much tamer, so packages that
need such shapes add them to the fixture (`exporter/internal/fixture/spec.go`)
or build a model in the test, like `diagram/scale.test.ts` does.

## Where things are

- `explorer/src/diagram/build.ts`: model → `Diagram` (pure data: nodes,
  edges, sizes, ELK options). `contractDiagram` (all datacenters, grouped by
  location) and `datacenterDiagram` (one datacenter: internet, LANs tiered
  by distance from it, devices between them, server groups, peers).
  `SIZE` holds box sizes; `base()` the shared node data.
- `explorer/src/diagram/layout.ts`: runs ELK. Every group is laid out on its
  own (SEPARATE_CHILDREN), so only edges between siblings get routed;
  edges across groups have no points and are drawn as curves, except with
  `Diagram.linkedLayout` (the contract view): there the top-level boxes such
  edges join are laid out together (INCLUDE_CHILDREN) and the edges routed.
- `explorer/src/diagram/elk.ts`: ELK in a web worker (`elk-worker.min.js`, 1.6 MB).
- `explorer/src/diagram/flow.ts`: layout → React Flow nodes/edges, with
  selection/search highlighting (`related`, `dim`, `hl`).
- `explorer/src/diagram/render.tsx`: node and edge renderers.
- `explorer/src/diagram/DiagramView.tsx`: the canvas: layout cache
  (`useLayout`, a WeakMap keyed by the model object), framing, legend.
- `explorer/src/diagram/types.ts`: `Diagram`, `DiagramNode`, `NodeData`,
  `Layout`.
- Tests: `diagram/diagram.test.ts` (demo fixture), `diagram/scale.test.ts`
  (240 datacenters, uses `elkjs/lib/elk.bundled.js` in Node).
- Model: `explorer/src/model/types.ts` (`GraphNode`, `GraphEdge`, `Model`);
  `model.edgesByNode`, `model.children`.
- App shell: `explorer/src/App.tsx` (hash state: `view`, `dc`, `node`, `q`).
- Styles: `explorer/src/App.css`; colour tokens (light + dark) in
  `explorer/src/index.css`.
- Architecture notes: `docs/ARCHITECTURE.md` (update the Diagram part when
  behaviour changes).

## Rules for every package

- **Privacy.** A real snapshot (`ionos-*.ionx`, git-ignored) may be in the
  repo root. Never print names, IPs, IDs or descriptions from it, never
  screenshot it, never copy anything from it into code, tests, fixtures or
  docs. Checks on it print counts only, and the selectors/filters must be
  tight enough that no text from it ends up in the output.
- **No commits** unless the user asks. Leave work uncommitted and say so.
- **Code style.** Match the surrounding code: small pure functions in
  `build.ts`, comments that say why, no semicolons, single quotes. Format
  touched files with
  `npx prettier --no-semi --single-quote --print-width 140 --write <files>`
  (only the files you changed).
- **Checks.** `make test` from the repo root runs Go tests, oxlint, vitest,
  tsc and the production build; it must pass. Add unit tests for every rule
  in `build.ts`/`layout.ts` (diagram data is pure and easy to test).
- **Browser check.** The dev server is `make explorer-dev`
  (`http://127.0.0.1:5173/`; start it in the background with
  `npm run dev -- --host 127.0.0.1 --port 5173 --strictPort` in `explorer/`
  if it is not running). Headless Chromium via `playwright-core` is set up
  in `/tmp/claude-1000/-home-k4ugummi-repos-ionos-explorer/8a2cf299-6964-4e1f-a027-17035bea0e73/scratchpad/pw/`
  (`node_modules`, write scripts there and run them with `node`; if it is
  gone, `npm i playwright-core@1.56` in a new scratch folder); the browser is
  `~/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`. Load the demo
  with the "Load demo snapshot" button and wait for `.dg-dc`. Check: no
  console errors, no requests to other hosts, light and dark mode
  (`page.emulateMedia({ colorScheme: 'dark' })`), 390 px width without
  horizontal overflow. Look at the screenshots.
- **Performance.** `scale.test.ts` must stay within its time budget; report
  layout times for the demo before/after when a package touches layout.
- **Docs.** Update `docs/ARCHITECTURE.md` (Diagram section) and the README
  feature paragraph when user-visible behaviour changes. Tick the package
  off above and note anything left over at the bottom of its file.

## Resuming

To continue after a cleared context: "Read docs/plans/canvas/README.md and
implement the next unticked package." Each package lists its acceptance
criteria; report against them when done.
