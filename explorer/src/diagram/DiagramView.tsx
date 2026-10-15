import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type EdgeTypes,
  type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Model } from '../model/types'
import { contractDiagram, datacenterDiagram } from './build'
import { elk } from './elk'
import { absolutePositions, layoutDiagram } from './layout'
import { DiagramActions, toFlow, type FlowEdge, type FlowNode } from './flow'
import { midpoint } from './geometry'
import { BoxNode, DcNode, GroupNode, InternetNode, PeerNode, RoutedEdge } from './render'
import type { Diagram, Layout } from './types'

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
  member: BoxNode,
  internet: InternetNode,
} as NodeTypes
const edgeTypes = { routed: RoutedEdge } as EdgeTypes

const cache = new WeakMap<Model, Map<string, Promise<Layout>>>()

function useLayout(model: Model, diagram: Diagram) {
  const [state, setState] = useState<{ key: string; layout?: Layout; error?: string }>()
  useEffect(() => {
    const layouts = cache.get(model) ?? new Map<string, Promise<Layout>>()
    cache.set(model, layouts)
    let pending = layouts.get(diagram.key)
    if (!pending) {
      pending = layoutDiagram(diagram, elk())
      layouts.set(diagram.key, pending)
      pending.catch(() => layouts.delete(diagram.key))
    }
    let live = true
    pending.then(
      (layout) => live && setState({ key: diagram.key, layout }),
      (err: unknown) => live && setState({ key: diagram.key, error: err instanceof Error ? err.message : String(err) }),
    )
    return () => {
      live = false
    }
  }, [model, diagram])
  return state?.key === diagram.key ? state : undefined
}

function Canvas({ model, dcId, selectedId, matches, onSelect, onOpenDc, rightInset = 0 }: DiagramViewProps) {
  const diagram = useMemo(() => (dcId ? datacenterDiagram(model, dcId) : contractDiagram(model)), [model, dcId])
  const state = useLayout(model, diagram)
  const layout = state?.layout
  const anchor = selectedId ? diagram.anchors.get(selectedId) : undefined
  const flow = useMemo(() => (layout ? toFlow(layout, diagram, anchor, matches) : undefined), [layout, diagram, anchor, matches])
  const abs = useMemo(() => (layout ? absolutePositions(layout) : undefined), [layout])
  const rf = useReactFlow()
  const box = useRef<HTMLDivElement>(null)
  const dc = dcId ? model.nodes.get(dcId) : undefined
  // Frame the diagram in the part of the canvas the drawer leaves free.
  const fit = useMemo(
    () => ({ padding: { top: '24px', left: '64px', bottom: '24px', right: `${rightInset + 24}px` } as const, maxZoom: 1, duration: 200 }),
    [rightInset],
  )
  const actions = useMemo(() => ({ openDc: (id: string) => onOpenDc(id) }), [onOpenDc])

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

  // A new diagram: frame the selection, or everything.
  const framed = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!flow || framed.current === layout?.key) return
    framed.current = layout?.key
    requestAnimationFrame(() => {
      if (target) centerOn(target, 1)
      else void rf.fitView({ ...fit, duration: 0 })
    })
    // centerOn reads the latest viewport; only the diagram change matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, layout?.key])

  // A new selection from outside the canvas: bring it into view if it is not.
  useEffect(() => {
    if (!target || framed.current !== layout?.key) return
    const { x, y, zoom } = rf.getViewport()
    const w = (box.current?.clientWidth ?? 0) - rightInset
    const h = box.current?.clientHeight ?? 0
    const visible =
      target.x * zoom + x >= 0 &&
      target.y * zoom + y >= 0 &&
      (target.x + target.width) * zoom + x <= w &&
      (target.y + target.height) * zoom + y <= h
    if (!visible) centerOn(target, Math.max(zoom, 0.7))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  function centerOn(t: { x: number; y: number; width: number; height: number }, zoom: number) {
    void rf.setCenter(t.x + t.width / 2 + rightInset / 2 / zoom, t.y + t.height / 2, { zoom, duration: 300 })
  }

  return (
    <DiagramActions.Provider value={actions}>
      <div className="diagram">
        <div className="dg-bar">
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
          <Legend datacenter={!!dc} />
        </div>
        <div className="dg-canvas" ref={box}>
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
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
            <Controls showInteractive={false} position="bottom-left" fitViewOptions={fit} />
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
              {state?.error ? `Layout failed: ${state.error}` : `Laying out ${diagram.nodes.length} elements…`}
            </div>
          )}
          {flow && diagram.nodes.length === 0 && <div className="dg-status">Nothing to draw here.</div>}
        </div>
      </div>
    </DiagramActions.Provider>
  )
}

function Legend({ datacenter }: { datacenter: boolean }) {
  const items: [string, string][] = datacenter
    ? [
        ['lan', 'LAN attachment'],
        ['internet', 'Internet'],
        ['cross-connect', 'Cross Connect'],
        ['target', 'Load balancer target (on selection)'],
      ]
    : [['cross-connect', 'Cross Connect']]
  return (
    <ul className="dg-legend" aria-label="Legend">
      {items.map(([kind, label]) => (
        <li key={kind}>
          <svg width="26" height="8" aria-hidden>
            <line x1="1" y1="4" x2="25" y2="4" className={`dg-legend-line ${kind}`} />
          </svg>
          {label}
        </li>
      ))}
      {!datacenter && <li className="dg-legend-hint">Double-click a datacenter to open it</li>}
    </ul>
  )
}
