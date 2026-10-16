import type { Edge, Node } from '@xyflow/react'
import { createContext } from 'react'
import { absolutePositions } from './layout'
import type { Diagram, DiagramEdgeKind, DiagramNode, Layout, Point } from './types'

export type FlowNodeData = {
  node: DiagramNode
  /** Search hits shown by this node (the node itself or what it contains). */
  matches: number
  dim: boolean
  /** Ends of the selected edge, or neighbours of the selected node. */
  related: boolean
}

export type FlowEdgeData = {
  kind: DiagramEdgeKind
  label?: string
  points?: Point[]
  /** Model node to select when the edge is clicked. */
  ref?: string
  showLabel: boolean
  /** Touches the selection: its label stays at every zoom. */
  hl: boolean
  /** Its route was dropped because the user moved an end: drawn as steps between the sides that face each other. */
  moved?: boolean
}

export type FlowNode = Node<FlowNodeData>
export type FlowEdge = Edge<FlowEdgeData>

export const DiagramActions = createContext<{
  openDc: (dcId: string) => void
  select: (id: string) => void
  /** Expands or collapses a box: a large group, or a router's folded LANs (`only.key`). */
  setOpen: (key: string, open: boolean) => void
}>({
  openDc: () => {},
  select: () => {},
  setOpen: () => {},
})

/** Lines that are hard to tell apart without their name. */
export const ALWAYS_LABELLED = new Set<DiagramEdgeKind>(['cross-connect', 'tunnel', 'manual'])

type Rect = Point & { width: number; height: number }

/**
 * The handles a line between two boxes leaves and enters by, for lines
 * without a route: down from the bottom into the top, or up from the top
 * into the bottom when the target lies above. With `sideways` (a line whose
 * route was dropped because a box was moved), boxes side by side are joined
 * left and right, whichever gap is wider.
 */
export function handles(s: Rect | undefined, t: Rect | undefined, sideways = false): [string, string] {
  if (!s || !t) return ['bottom', 'top']
  const down = t.y - (s.y + s.height)
  const up = s.y - (t.y + t.height)
  const right = t.x - (s.x + s.width)
  const left = s.x - (t.x + t.width)
  if (sideways && Math.max(right, left) > Math.max(down, up, 0)) return right >= left ? ['right-out', 'left-in'] : ['left-out', 'right-in']
  return up >= 0 && up >= down ? ['top-out', 'bottom-in'] : ['bottom', 'top']
}

/**
 * Turns a layout into React Flow elements with selection and search state
 * applied. `emphasis` (model ids, from a layer emphasis) dims everything
 * else like a search does, without marking anything as a hit. `draggable`
 * lists the boxes the user may move (own positions).
 */
export function toFlow(
  layout: Layout,
  diagram: Diagram,
  anchor: string | undefined,
  matches: Set<string> | null,
  emphasis: Set<string> | null = null,
  draggable?: ReadonlySet<string>,
) {
  const byId = new Map(layout.nodes.map((n) => [n.id, n]))
  const selectedNode = anchor && byId.has(anchor) ? anchor : undefined
  const selectedEdge = anchor && !selectedNode ? anchor : undefined
  // A grouped server carries its LAN links on the group box.
  const boxes = new Set<string>()
  if (selectedNode) {
    boxes.add(selectedNode)
    const n = byId.get(selectedNode)!
    if (n.type === 'member' && n.parent) boxes.add(n.parent)
  }

  const hits = new Map<string, number>()
  const hiddenHits = new Map<string, Set<string>>() // "more" box → hidden members with a hit
  if (matches) {
    for (const id of matches) {
      const a = diagram.anchors.get(id)
      if (!a || !byId.has(a)) continue
      for (let n = byId.get(a); n; n = n.parent ? byId.get(n.parent) : undefined) hits.set(n.id, (hits.get(n.id) ?? 0) + 1)
      const member = diagram.hidden?.get(id)
      if (member) hiddenHits.set(a, (hiddenHits.get(a) ?? new Set()).add(member))
    }
  }
  const bright = emphasis && litBy(emphasis, diagram, byId)
  const lit = (id: string) => (!matches || (hits.get(id) ?? 0) > 0) && (!bright || bright.has(id))

  // Unrouted edges to a box above (a router's LAN nearer the internet) leave
  // from the top instead of looping round from the bottom.
  const abs = absolutePositions(layout)

  const related = new Set<string>()
  const edges: FlowEdge[] = layout.edges.map((e) => {
    const [sourceHandle, targetHandle] = e.points ? ['bottom', 'top'] : handles(abs.get(e.source), abs.get(e.target), e.moved)
    const touches = boxes.has(e.source) || boxes.has(e.target)
    const hl = touches || e.id === selectedEdge
    const hidden = e.onDemand && !touches
    if (hl && !hidden) related.add(e.source).add(e.target)
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle,
      targetHandle,
      type: 'routed',
      hidden,
      selectable: !!e.ref,
      zIndex: hl ? 2 : 1,
      className: ['dg-edge', e.kind, hl && 'hl', e.moved && 'moved', !(lit(e.source) || lit(e.target) || bright?.has(e.id)) && 'dim']
        .filter(Boolean)
        .join(' '),
      data: {
        kind: e.kind,
        label: e.label,
        points: e.points,
        ref: e.ref,
        showLabel: (hl && e.kind !== 'target') || (ALWAYS_LABELLED.has(e.kind) && !!e.label),
        hl,
        moved: e.moved,
      },
    }
  })

  const nodes: FlowNode[] = layout.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    parentId: n.parent,
    position: { x: n.x, y: n.y },
    width: n.width,
    height: n.height,
    // Sizes are fixed, so a box is ready to drag at once; React Flow keeps its handles instead of measuring them again.
    measured: { width: n.width, height: n.height },
    style: { width: n.width, height: n.height },
    zIndex: n.type === 'group' ? 0 : 3,
    selected: n.id === selectedNode,
    selectable: !!n.ref,
    draggable: !!draggable?.has(n.id),
    data: {
      node: n,
      // A "more" box counts the members it hides that match, not their NICs and volumes as well.
      matches: n.type === 'group' ? 0 : n.type === 'more' ? (hiddenHits.get(n.id)?.size ?? 0) : (matches && hits.get(n.id)) || 0,
      dim: !lit(n.id),
      related: related.has(n.id) && n.id !== selectedNode,
    },
  }))
  return { nodes, edges }
}

/**
 * The boxes that show any of these model nodes, with the groups around them,
 * and the lines that stand for one (a Cross Connect drawn as a line).
 */
function litBy(ids: Set<string>, diagram: Diagram, byId: Map<string, Layout['nodes'][number]>) {
  const out = new Set<string>()
  for (const id of ids) {
    const a = diagram.anchors.get(id)
    if (!a) continue
    if (!byId.has(a)) out.add(a)
    for (let n = byId.get(a); n && !out.has(n.id); n = n.parent ? byId.get(n.parent) : undefined) out.add(n.id)
  }
  return out
}
