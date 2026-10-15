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
  for (const e of routedEdges(diagram)) {
    elkNodes.get(parentOf.get(e.source)!)!.edges!.push({ id: e.id, sources: [e.source], targets: [e.target] })
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

/** Edges ELK routes: both ends in the same group (or both top level), and always drawn. */
function routedEdges(diagram: Diagram) {
  const parentOf = new Map(diagram.nodes.map((n) => [n.id, n.parent ?? '']))
  return diagram.edges.filter((e) => !e.onDemand && parentOf.has(e.source) && parentOf.get(e.source) === parentOf.get(e.target))
}

/**
 * Everything the layout depends on, as a string: node ids, types, parents,
 * sizes and ELK options in diagram order (ELK keeps the model order), plus
 * the edges ELK routes. Titles, pills, tags and change markers only affect
 * rendering, so diagrams that differ in those share a layout.
 */
export function layoutSignature(diagram: Diagram): string {
  return JSON.stringify([
    diagram.key,
    diagram.rootLayout,
    diagram.nodes.map((n) => [n.id, n.type, n.parent ?? '', n.width ?? -1, n.height ?? -1, n.layout ?? null]),
    routedEdges(diagram).map((e) => [e.id, e.source, e.target]),
  ])
}

/**
 * A layout with the current diagram's node data and edges on the cached
 * positions. Only for a layout with the same signature: every node is in
 * it, and routed edges keep their points.
 */
export function withData(layout: Layout, diagram: Diagram): Layout {
  const nodes = new Map(diagram.nodes.map((n) => [n.id, n]))
  const points = new Map(layout.edges.flatMap((e) => (e.points ? [[e.id, e.points] as const] : [])))
  return {
    key: diagram.key,
    nodes: layout.nodes.map((p) => ({ ...p, ...nodes.get(p.id), x: p.x, y: p.y, width: p.width, height: p.height })),
    edges: diagram.edges.map((e): PlacedEdge => (points.has(e.id) ? { ...e, points: points.get(e.id) } : { ...e })),
  }
}

export interface CachedLayout {
  promise: Promise<Layout>
  /** Set once the layout is done, so a cached view can be drawn without waiting a tick. */
  layout?: Layout
}

/**
 * Layouts by signature, the most recently used `max` kept. Model rebuilds
 * (annotations, comparisons) produce new diagram objects with the same
 * signature, so they reuse the layout instead of running ELK again.
 */
export function layoutCache(run: (diagram: Diagram) => Promise<Layout>, max = 30) {
  const entries = new Map<string, CachedLayout>()
  return {
    /** The layout for a diagram, run now if it is not cached. */
    get(diagram: Diagram, signature = layoutSignature(diagram)): CachedLayout {
      let entry = entries.get(signature)
      if (entry) {
        entries.delete(signature)
      } else {
        const promise = run(diagram)
        const e: CachedLayout = { promise }
        promise.then(
          (layout) => (e.layout = layout),
          () => entries.get(signature) === e && entries.delete(signature),
        )
        entry = e
      }
      entries.set(signature, entry)
      for (const oldest of entries.keys()) {
        if (entries.size <= max) break
        entries.delete(oldest)
      }
      return entry
    },
    /** The cached layout, without running one. */
    peek: (signature: string) => entries.get(signature),
  }
}
