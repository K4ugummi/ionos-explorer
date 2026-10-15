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
const ALWAYS_LABELLED = new Set<DiagramEdgeKind>(['cross-connect', 'tunnel', 'manual'])

/** Turns a layout into React Flow elements with selection and search state applied. */
export function toFlow(layout: Layout, diagram: Diagram, anchor: string | undefined, matches: Set<string> | null) {
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
  const lit = (id: string) => !matches || (hits.get(id) ?? 0) > 0

  // Unrouted edges to a box above (a router's LAN nearer the internet) leave
  // from the top instead of looping round from the bottom.
  const abs = absolutePositions(layout)
  const upwards = (source: string, target: string) => {
    const [s, t] = [abs.get(source), abs.get(target)]
    return !!s && !!t && t.y + t.height <= s.y
  }

  const related = new Set<string>()
  const edges: FlowEdge[] = layout.edges.map((e) => {
    const up = !e.points && upwards(e.source, e.target)
    const touches = boxes.has(e.source) || boxes.has(e.target)
    const hl = touches || e.id === selectedEdge
    const hidden = e.onDemand && !touches
    if (hl && !hidden) related.add(e.source).add(e.target)
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: up ? 'top-out' : 'bottom',
      targetHandle: up ? 'bottom-in' : 'top',
      type: 'routed',
      hidden,
      selectable: !!e.ref,
      zIndex: hl ? 2 : 1,
      className: ['dg-edge', e.kind, hl && 'hl', !(lit(e.source) || lit(e.target)) && 'dim'].filter(Boolean).join(' '),
      data: {
        kind: e.kind,
        label: e.label,
        points: e.points,
        ref: e.ref,
        showLabel: (hl && e.kind !== 'target') || (ALWAYS_LABELLED.has(e.kind) && !!e.label),
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
    style: { width: n.width, height: n.height },
    zIndex: n.type === 'group' ? 0 : 3,
    selected: n.id === selectedNode,
    selectable: !!n.ref,
    draggable: false,
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
