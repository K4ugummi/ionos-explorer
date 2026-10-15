# 01 Quick wins

Four small fixes that make the canvas feel faster and less fragile.

## 1. Keep layouts across model rebuilds

**Problem.** `useLayout` in `DiagramView.tsx` caches layouts in a `WeakMap`
keyed by the `Model` object. The app builds a new model object whenever
annotations change (a manual link, an IP correction) or a comparison is
loaded (`markChanges`), so every such edit throws the cache away and ELK
lays out the whole view again (visible as "Laying out N elements…").

**Do.** Key the cache by what the layout actually depends on: a signature
of the diagram, i.e. node ids, types, parents, sizes and layout options,
plus edges that ELK routes (same parent, not `onDemand`). Data that only
affects rendering (titles, subtitles, pills, tags, change markers) must not
be part of it.

- Add `layoutSignature(diagram): string` in `layout.ts` (pure, tested).
- Cache: module-level `Map<string, Promise<Layout>>` (LRU, ~30 entries) keyed
  by the signature.
- A cached `Layout` holds `PlacedNode`s with their `data`; when the signature
  matches but data differs, re-attach the current diagram's node data and
  edges to the cached positions (a small `withData(layout, diagram)`), so
  new titles and markers show up without re-layout.

**Accept.**
- Unit test: two diagrams that differ only in node data have the same
  signature; changing a size, parent or routed edge changes it.
- Browser: add a manual link on a server (details → Add link…) and come
  back to the diagram; it does not show "Laying out…" again for a view
  laid out before. Labels/markers still update.

## 2. Refit when the canvas size changes

**Problem.** The view is fitted once per diagram. Resizing the window, or
opening/closing the details drawer on a narrow screen, leaves the drawing
cut off or tiny.

**Do.** A `ResizeObserver` on `.dg-canvas`. If the user has not panned or
zoomed since the last automatic fit (track `onMoveStart` with a user event,
React Flow passes the source event), refit after the size settles
(debounce ~150 ms). If they have moved, keep their viewport.

**Accept.** Browser: load the demo, resize the viewport from 1500 to 900 px
wide → the contract view is refitted (all datacenter cards visible). Pan
first, then resize → viewport is kept.

## 3. Legend that fits

**Problem.** `.dg-legend` sits in `.dg-bar` and is cut off when the details
drawer is open or the window is narrow (e.g. "Load balance…" in a
datacenter view with the drawer open).

**Do.** When it does not fit, show a "Legend" button that opens it as a
small popover over the canvas (top right, left of the drawer). Keep the
inline legend when there is room. No new dependencies; a `details/summary`
or a simple toggle with `aria-expanded` is enough. Close with Escape and on
outside click.

**Accept.** Browser at 1500 px with the drawer open and at 390 px: all
legend entries readable (screenshot), no overflow, keyboard reachable.

## 4. Load the diagram code only when needed

**Problem.** One 607 kB JS bundle plus the 1.6 MB ELK worker. React Flow,
the diagram code and ELK are needed only for the Diagram tab, yet everything
loads with the open screen.

**Do.** `React.lazy(() => import('./diagram/DiagramView'))` in `App.tsx`
with a `Suspense` fallback that looks like the existing "Laying out…"
status. `diagramFor` (used by navigation) lives in `build.ts`, which is
cheap; keep that import static or move `diagramFor` to a small module so
the lazy chunk really contains React Flow and ELK. The worker is already a
separate file and only fetched when `elk()` is first called; keep it so.

**Accept.** `make explorer-build` (or `make test`) shows a main chunk
noticeably smaller than 607 kB and a separate diagram chunk; report both
sizes. The app still opens the demo straight into the diagram without a
visible delay beyond the existing status line. The CSP in `index.html`
still allows it (scripts from `'self'` only).

## Left over

Done 2026-10-15. Notes and deviations:

- **1. Cache.** `layoutSignature`, `withData` and an LRU `layoutCache`
  (get/peek, 30 entries) live in `layout.ts`; `layout.test.ts` covers them.
  A cached view is drawn without a "Laying out…" frame (`peek`), and while
  the same view is laid out again its old drawing stays up, as before.
  A manual link that adds a box to a view (e.g. a peer datacenter the
  link leads to) or connects siblings still lays that view out again: the
  layout really changes. The contract view and comparisons reuse layouts.
- **2. Refit.** The canvas remembers how it last framed the view itself
  (fit, or centred on the selection: `framing.ts`) and repeats that 150 ms
  after a resize. User moves are pans/zooms with an event in `onMoveStart`,
  the zoom buttons and minimap drags/wheel (both move the view without an
  event). The details drawer is an overlay, so opening it does not change
  the canvas size and does not refit; it only changes the fit padding.
- **3. Legend.** An invisible copy measures the one-line width; the bar's
  free room decides between inline and the button. The bar now ends where
  the side drawer starts and sits above the drawer (z-index 11), so the
  popover is never covered, also by the bottom drawer on phones.
- **4. Lazy loading.** Not `React.lazy`/`Suspense`: a lazy component
  suspends even when its chunk is loaded, and React 19 keeps a shown
  fallback for 300 ms, which made opening the demo ~300 ms slower. `App.tsx`
  loads the chunk with a small hook instead ("Loading the diagram…" status
  in the `.dg-status` style) and starts fetching it on the first
  pointerdown/keydown/dragenter on the open screen, in parallel with
  reading the snapshot. Main chunk 635.6 → 443.4 kB (gzip 208.5 → 146.6);
  diagram chunk 197.6 kB (gzip 64.0) plus 15.4 kB CSS. Click on "Load demo
  snapshot" to the first card is unchanged (~1.0–1.1 s, median of 5 in
  headless Chromium); the open screen appears ~10–15 % sooner.
  `chunkSizeWarningLimit` in `vite.config.ts` is no longer needed.
- **Bug, not from this package, seen while checking:** edges to a server
  group (the one LAN link per group) are not drawn at all. `GroupNode`
  renders no handles, so React Flow drops them and, in dev mode, warns
  "Couldn't create edge for source/target handle id: null" (error 008).
  In the demo's fra-prod-core view 0 of the 18 rendered edges touch a
  group, before and after this package. Fix first in package 02 or 03,
  which work on exactly these edges.
  **Fixed** right after: `GroupNode` renders the same top/bottom handles as
  other boxes; fra-prod-core now draws 9 edges to its server groups and the
  warning is gone.
