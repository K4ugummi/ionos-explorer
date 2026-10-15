import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStoreApi,
  type EdgeTypes,
  type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { CompareContext } from '../diff/context'
import type { Model } from '../model/types'
import { contractDiagram, datacenterDiagram } from './build'
import { elk } from './elk'
import { useDismiss } from './dismiss'
import { legendFits, refitOnResize, type Box, type Framing } from './framing'
import { emphasized, loadLayers, saveLayers, type Layers } from './layers'
import { LayersMenu } from './LayersMenu'
import { lodFor, type Lod } from './lod'
import { absolutePositions, layoutCache, layoutDiagram, layoutSignature, withData } from './layout'
import { DiagramActions, toFlow, type FlowEdge, type FlowNode } from './flow'
import { midpoint } from './geometry'
import { BoxNode, DcNode, ExternalNode, GroupNode, InternetNode, MoreNode, PeerNode, RoutedEdge } from './render'
import type { Diagram, DiagramEdgeKind, Layout } from './types'

export interface DiagramViewProps {
  model: Model
  /** Datacenter to show; the contract overview when absent. */
  dcId?: string
  selectedId?: string
  /** Model ids matching the current search, or null when not searching. */
  matches: Set<string> | null
  onSelect: (id?: string) => void
  onOpenDc: (dcId?: string) => void
  /** Width covered by an overlay on the right (the detail drawer). */
  rightInset?: number
}

export function DiagramView(props: DiagramViewProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  )
}

// The renderers are typed for FlowNode; React Flow's maps are untyped.
const nodeTypes = {
  group: GroupNode,
  dc: DcNode,
  peer: PeerNode,
  hub: BoxNode,
  lan: BoxNode,
  resource: BoxNode,
  router: BoxNode,
  member: BoxNode,
  more: MoreNode,
  internet: InternetNode,
  external: ExternalNode,
} as NodeTypes
const edgeTypes = { routed: RoutedEdge } as EdgeTypes

// Layouts survive model rebuilds (annotations, comparisons): they are keyed
// by what ELK sees, not by the model object.
const layouts = layoutCache((d) => layoutDiagram(d, elk()))

function useLayout(diagram: Diagram) {
  const signature = useMemo(() => layoutSignature(diagram), [diagram])
  const [state, setState] = useState<{ signature: string; layout?: Layout; error?: string }>()
  useEffect(() => {
    let live = true
    layouts.get(diagram, signature).promise.then(
      (layout) => live && setState({ signature, layout }),
      (err: unknown) => live && setState({ signature, error: err instanceof Error ? err.message : String(err) }),
    )
    return () => {
      live = false
    }
  }, [diagram, signature])
  const current = state?.signature === signature ? state : undefined
  // A view laid out before is drawn at once, without a "Laying out…" frame.
  const placed = current?.layout ?? (current ? undefined : layouts.peek(signature)?.layout)
  // While the same view is laid out again (a new routed edge), keep showing the old drawing.
  const stale = !current && !placed && state?.layout?.key === diagram.key ? state.layout : undefined
  const layout = useMemo(() => (placed ? withData(placed, diagram) : stale), [placed, stale, diagram])
  return { layout, fresh: !!placed, error: current?.error }
}

const NOTHING_OPEN: ReadonlySet<string> = new Set()

function Canvas({ model, dcId, selectedId, matches, onSelect, onOpenDc, rightInset = 0 }: DiagramViewProps) {
  // Groups and routers the user opened, per view. Part of the diagram, so
  // the open and the closed state are laid out (and cached) separately.
  // Search matches are not: they never change the layout, a collapsed
  // group counts them on its "+N more" box instead.
  const [opened, setOpened] = useState<ReadonlyMap<string, ReadonlySet<string>>>(new Map())
  // What the diagram shows, per viewer (this browser). Hidden layers are
  // part of the diagram and so of the layout; the emphasis only dims.
  const [layers, setLayers] = useState<Layers>(loadLayers)
  const diff = useContext(CompareContext)
  const viewKey = dcId ? `dc:${dcId}` : 'contract'
  const expanded = opened.get(viewKey) ?? NOTHING_OPEN
  // Only a datacenter view depends on the selection: a selected member of a collapsed group is shown.
  const focus = dcId ? selectedId : undefined
  const diagram = useMemo(
    () =>
      dcId
        ? datacenterDiagram(model, dcId, { expanded, selected: focus, hidden: layers.hidden })
        : contractDiagram(model, { hidden: layers.hidden }),
    [model, dcId, expanded, focus, layers.hidden],
  )
  const bright = useMemo(() => emphasized(model, layers.emphasis, !!diff), [model, layers.emphasis, diff])
  // The legend lists only the lines this view draws (a peer line looks like a Cross Connect).
  const kinds = useMemo(() => new Set(diagram.edges.map((e) => (e.kind === 'peer' ? 'cross-connect' : e.kind))), [diagram])
  const state = useLayout(diagram)
  const layout = state.layout
  const anchor = selectedId ? diagram.anchors.get(selectedId) : undefined
  const flow = useMemo(
    () => (layout ? toFlow(layout, diagram, anchor, matches, bright) : undefined),
    [layout, diagram, anchor, matches, bright],
  )
  const abs = useMemo(() => (layout ? absolutePositions(layout) : undefined), [layout])
  const rf = useReactFlow()
  const box = useRef<HTMLDivElement>(null)
  const dc = dcId ? model.nodes.get(dcId) : undefined
  // Frame the diagram in the part of the canvas the drawer leaves free.
  const fit = useMemo(
    () => ({ padding: { top: '24px', left: '64px', bottom: '24px', right: `${rightInset + 24}px` } as const, maxZoom: 1, duration: 200 }),
    [rightInset],
  )
  // The box the user just opened or closed: kept in view once the new layout is there.
  const [reveal, setReveal] = useState<string>()
  const actions = useMemo(
    () => ({
      openDc: (id: string) => onOpenDc(id),
      select: (id: string) => onSelect(id),
      setOpen: (key: string, open: boolean) => {
        setOpened((all) => {
          const next = new Set(all.get(viewKey))
          if (open) next.add(key)
          else next.delete(key)
          return new Map(all).set(viewKey, next)
        })
        // A router's LANs open around it; a group in place.
        setReveal(key.startsWith('lans:') ? key.slice(5) : key)
      },
    }),
    [onOpenDc, onSelect, viewKey],
  )

  // Where the selection sits on the canvas, if it is shown at all.
  const target = useMemo(() => {
    if (!anchor || !layout || !abs) return undefined
    const n = abs.get(anchor)
    if (n) return n
    const e = layout.edges.find((x) => x.id === anchor)
    const [s, t] = [abs.get(e?.source ?? ''), abs.get(e?.target ?? '')]
    if (e?.points) return { ...midpoint(e.points), width: 0, height: 0 }
    if (s && t) return { x: (s.x + t.x) / 2, y: (s.y + t.y) / 2, width: 0, height: 0 }
    return undefined
  }, [anchor, layout, abs])

  // How the canvas last placed the view itself; cleared when the user moves it.
  const framing = useRef<Framing | undefined>(undefined)
  const userMoved = () => (framing.current = undefined)
  const lod = useLod(framing)

  // A new diagram: frame the selection, or everything.
  const framed = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!flow || framed.current === layout?.key) return
    framed.current = layout?.key
    requestAnimationFrame(() => {
      // Set first: an unanimated move reaches the level of detail at once.
      framing.current = target ? { kind: 'center', target, zoom: 1 } : { kind: 'fit' }
      if (target) centerOn(target, 1)
      else void rf.fitView({ ...fit, duration: 0 })
    })
    // centerOn reads the latest viewport; only the diagram change matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, layout?.key])

  // A new selection from outside the canvas: bring it into view if it is not.
  // Once per selection: opening a group elsewhere lays the view out again
  // and must not pull it back. A member revealed by the selection (it was
  // in a collapsed group) has a target only once its layout is there.
  const brought = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!target) {
      if (!anchor) brought.current = undefined
      return
    }
    if (framed.current !== layout?.key || brought.current === anchor) return
    brought.current = anchor
    if (inView(target)) return
    const z = Math.max(rf.getViewport().zoom, 0.7)
    framing.current = { kind: 'center', target, zoom: z }
    centerOn(target, z)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  // An opened or closed group: once laid out, keep it in view (zooming out if it does not fit).
  useEffect(() => {
    if (!reveal || !state.fresh || !abs) return
    setReveal(undefined)
    const b = abs.get(reveal)
    if (!b || inView(b)) return
    const { width, height } = free()
    const z = Math.min(rf.getViewport().zoom, (width - 48) / b.width, (height - 48) / b.height)
    framing.current = { kind: 'center', target: b, zoom: z }
    centerOn(b, z)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, state.fresh, abs])

  // Layers switched on or off: once laid out, frame the view again if the canvas framed it.
  const [relaid, setRelaid] = useState(false)
  const changeLayers = (next: Layers) => {
    if (next.hidden !== layers.hidden) setRelaid(true)
    setLayers(next)
    saveLayers(next)
  }
  useEffect(() => {
    if (!relaid || !state.fresh) return
    setRelaid(false)
    requestAnimationFrame(() => refit.current())
  }, [relaid, state.fresh, layout])

  /** The part of the canvas the drawer leaves free. */
  function free() {
    return { width: (box.current?.clientWidth ?? 0) - rightInset, height: box.current?.clientHeight ?? 0 }
  }

  function inView(t: Box) {
    const { x, y, zoom } = rf.getViewport()
    const { width, height } = free()
    return t.x * zoom + x >= 0 && t.y * zoom + y >= 0 && (t.x + t.width) * zoom + x <= width && (t.y + t.height) * zoom + y <= height
  }

  function centerOn(t: Box, zoom: number) {
    void rf.setCenter(t.x + t.width / 2 + rightInset / 2 / zoom, t.y + t.height / 2, { zoom, duration: 300 })
  }

  // The canvas changed size (window, panels): frame again the way the canvas
  // last did, once the size has settled. A view the user moved stays put.
  const refit = useRef(() => {})
  useEffect(() => {
    refit.current = () => {
      const f = framing.current
      if (f?.kind === 'fit') void rf.fitView(fit)
      else if (f?.kind === 'center') centerOn(f.target, f.zoom)
    }
  })
  useEffect(() => {
    const el = box.current
    if (!el) return
    let size = { width: el.clientWidth, height: el.clientHeight }
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const next = { width: el.clientWidth, height: el.clientHeight }
        if (refitOnResize(framing.current, size, next)) refit.current()
        size = next
      }, 150)
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      clearTimeout(timer)
    }
  }, [])

  return (
    <DiagramActions.Provider value={actions}>
      <div className="diagram">
        <div className="dg-bar" style={{ marginRight: rightInset }}>
          <nav className="crumbs" aria-label="Diagram">
            {dc ? (
              <>
                <button onClick={() => onOpenDc(undefined)}>All datacenters</button>
                <span className="sep">›</span>
                <strong>{dc.name}</strong>
                {dc.location && <span className="pill">{dc.location}</span>}
              </>
            ) : (
              <strong>All datacenters</strong>
            )}
          </nav>
          <Legend datacenter={!!dc} kinds={kinds} />
          <LayersMenu layers={layers} onChange={changeLayers} datacenter={!!dc} comparing={!!diff} />
        </div>
        <div
          className={`dg-canvas lod-${lod}`}
          ref={box}
          // The minimap moves the view without telling onMoveStart who did it.
          onPointerDownCapture={(e) => (e.target as Element).closest('.react-flow__minimap') && userMoved()}
          onWheelCapture={(e) => (e.target as Element).closest('.react-flow__minimap') && userMoved()}
        >
          <ReactFlow<FlowNode, FlowEdge>
            nodes={flow?.nodes ?? []}
            edges={flow?.edges ?? []}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            zoomOnDoubleClick={false}
            minZoom={0.04}
            maxZoom={2}
            onlyRenderVisibleElements
            colorMode="system"
            onNodeClick={(_, n) => {
              const d = n.data.node
              if (d.type === 'peer') onOpenDc(d.ref)
              else if (d.ref) onSelect(d.ref)
            }}
            onNodeDoubleClick={(_, n) => n.data.node.type === 'dc' && onOpenDc(n.data.node.ref)}
            onEdgeClick={(_, e) => e.data?.ref && onSelect(e.data.ref)}
            onPaneClick={() => onSelect(undefined)}
            // React Flow passes the event only when the user pans or zooms.
            onMoveStart={(e) => e && userMoved()}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
            <Controls
              showInteractive={false}
              position="bottom-left"
              fitViewOptions={fit}
              onZoomIn={userMoved}
              onZoomOut={userMoved}
              onFitView={() => (framing.current = { kind: 'fit' })}
            />
            <MiniMap
              pannable
              zoomable
              position="bottom-right"
              nodeClassName={(n) => `mm-${(n as FlowNode).data.node.type}`}
              style={{ marginRight: rightInset + 12 }}
            />
          </ReactFlow>
          {!flow && (
            <div className="dg-status" role="status">
              {state.error ? `Layout failed: ${state.error}` : `Laying out ${diagram.nodes.length} elements…`}
            </div>
          )}
          {flow && diagram.nodes.length === 0 && <div className="dg-status">Nothing to draw here.</div>}
        </div>
      </div>
    </DiagramActions.Provider>
  )
}

/**
 * The level of detail for the current zoom. Only a change of level renders
 * the canvas again (a class on it); the boxes restyle in CSS. Hysteresis
 * only while the user zooms: a view the canvas framed itself (`framing` is
 * set) gets the plain level of its zoom, so a fitted view always looks the same.
 */
function useLod(framing: RefObject<Framing | undefined>) {
  const store = useStoreApi()
  const [lod, setLod] = useState<Lod>(() => lodFor(store.getState().transform[2]))
  useEffect(() => store.subscribe((s) => setLod((prev) => lodFor(s.transform[2], framing.current ? undefined : prev))), [store, framing])
  return lod
}

/**
 * The legend sits in the bar while it fits on one line next to the
 * breadcrumbs; otherwise a "Legend" button opens it over the canvas.
 */
function Legend({ datacenter, kinds }: { datacenter: boolean; kinds: ReadonlySet<DiagramEdgeKind> }) {
  const slot = useRef<HTMLDivElement>(null)
  const measure = useRef<HTMLUListElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const [fits, setFits] = useState(true)
  const [open, setOpen] = useState(false)
  const id = useId()

  useLayoutEffect(() => {
    const [s, m] = [slot.current, measure.current]
    if (!s || !m) return
    const check = () => setFits(legendFits(m.getBoundingClientRect().width, s.getBoundingClientRect().width))
    check()
    const observer = new ResizeObserver(check)
    observer.observe(s)
    observer.observe(m) // its entries change with the view and comparisons
    return () => observer.disconnect()
  }, [])

  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, close, slot, toggle)

  return (
    <div className="dg-legend-slot" ref={slot}>
      <ul className="dg-legend dg-legend-measure" ref={measure} aria-hidden>
        <LegendItems datacenter={datacenter} kinds={kinds} />
      </ul>
      {fits ? (
        <ul className="dg-legend" aria-label="Legend">
          <LegendItems datacenter={datacenter} kinds={kinds} />
        </ul>
      ) : (
        <>
          <button
            ref={toggle}
            className="btn small dg-legend-toggle"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen((o) => !o)}
          >
            Legend
          </button>
          {open && (
            <ul className="dg-legend dg-legend-pop" id={id} aria-label="Legend">
              <LegendItems datacenter={datacenter} kinds={kinds} />
            </ul>
          )}
        </>
      )}
    </div>
  )
}

function LegendItems({ datacenter, kinds }: { datacenter: boolean; kinds: ReadonlySet<DiagramEdgeKind> }) {
  const diff = useContext(CompareContext)
  const items: [DiagramEdgeKind, string][] = datacenter
    ? [
        ['lan', 'LAN attachment'],
        ['internet', 'Internet'],
        ['cross-connect', 'Cross Connect'],
        ['tunnel', 'VPN tunnel'],
        ['manual', 'Manual link'],
        ['target', 'Load balancer target (on selection)'],
      ]
    : [
        ['cross-connect', 'Cross Connect'],
        ['tunnel', 'VPN tunnel'],
        ['manual', 'Manual link'],
      ]
  return (
    <>
      {items
        .filter(([kind]) => kinds.has(kind))
        .map(([kind, label]) => (
          <li key={kind}>
            <svg width="26" height="8" aria-hidden>
              <line x1="1" y1="4" x2="25" y2="4" className={`dg-legend-line ${kind}`} />
            </svg>
            {label}
          </li>
        ))}
      {diff && (
        <>
          <li>
            <span className="dg-legend-bar added" aria-hidden />
            New
          </li>
          <li>
            <span className="dg-legend-bar changed" aria-hidden />
            Changed since {new Date(diff.older.manifest.createdAt).toLocaleDateString()}
          </li>
        </>
      )}
      {!datacenter && <li className="dg-legend-hint">Double-click a datacenter to open it</li>}
    </>
  )
}
