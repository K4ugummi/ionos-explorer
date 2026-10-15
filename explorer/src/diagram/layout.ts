import type { ELK, ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api'
import type { Diagram, Layout, PlacedEdge, PlacedNode, Point } from './types'

/**
 * Runs ELK over a diagram. Every group is laid out on its own with its own
 * algorithm (ELK's default SEPARATE_CHILDREN), so only edges between
 * siblings are routed by ELK; edges that cross group borders are left
 * without points and drawn as plain curves by the renderer.
 */
export async function layoutDiagram(diagram: Diagram, elk: ELK): Promise<Layout> {
  const root: ElkNode = {
    id: '__root',
    layoutOptions: { ...diagram.rootLayout, 'elk.json.edgeCoords': 'ROOT', 'elk.json.shapeCoords': 'PARENT' },
    children: [],
    edges: [],
  }
  const elkNodes = new Map<string, ElkNode>([[root.id, root]])
  for (const n of diagram.nodes) {
    // ELK's JSON importer chokes on keys that are present but undefined.
    elkNodes.set(
      n.id,
      n.type === 'group'
        ? { id: n.id, layoutOptions: n.layout ?? {}, children: [], edges: [] }
        : { id: n.id, width: n.width!, height: n.height! },
    )
  }
  for (const n of diagram.nodes) {
    const parent = elkNodes.get(n.parent ?? root.id)
    if (!parent?.children) throw new Error(`diagram node ${n.id}: parent ${n.parent} is not a group`)
    parent.children.push(elkNodes.get(n.id)!)
  }

  const parentOf = new Map(diagram.nodes.map((n) => [n.id, n.parent ?? root.id]))
  const routed = new Set<string>()
  for (const e of diagram.edges) {
    const container = parentOf.get(e.source)
    if (e.onDemand || !container || container !== parentOf.get(e.target)) continue
    elkNodes.get(container)!.edges!.push({ id: e.id, sources: [e.source], targets: [e.target] })
    routed.add(e.id)
  }

  const result = await elk.layout(root)

  const nodes: PlacedNode[] = []
  const edges = new Map<string, Point[]>()
  const visit = (n: ElkNode) => {
    for (const c of n.children ?? []) {
      const d = diagram.nodes.find((x) => x.id === c.id)
      if (d) nodes.push({ ...d, x: c.x ?? 0, y: c.y ?? 0, width: c.width ?? d.width ?? 0, height: c.height ?? d.height ?? 0 })
      visit(c)
    }
    for (const e of (n.edges ?? []) as ElkExtendedEdge[]) {
      const s = e.sections?.[0]
      if (s) edges.set(e.id, [s.startPoint, ...(s.bendPoints ?? []), s.endPoint])
    }
  }
  visit(result)
  // Parents first, as React Flow requires.
  const order = new Map(diagram.nodes.map((n, i) => [n.id, i]))
  const depth = (id: string): number => {
    const p = diagram.nodes[order.get(id)!]?.parent
    return p ? 1 + depth(p) : 0
  }
  nodes.sort((a, b) => depth(a.id) - depth(b.id) || order.get(a.id)! - order.get(b.id)!)

  return {
    key: diagram.key,
    nodes,
    edges: diagram.edges.map((e): PlacedEdge => (routed.has(e.id) && edges.has(e.id) ? { ...e, points: edges.get(e.id) } : { ...e })),
  }
}

/** Absolute position of every node (layout positions are relative to the parent). */
export function absolutePositions(layout: Layout): Map<string, Point & { width: number; height: number }> {
  const out = new Map<string, Point & { width: number; height: number }>()
  for (const n of layout.nodes) {
    const p = n.parent ? out.get(n.parent) : undefined
    out.set(n.id, { x: n.x + (p?.x ?? 0), y: n.y + (p?.y ?? 0), width: n.width, height: n.height })
  }
  return out
}
