import type { ELK, ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api'
import type { Diagram, Layout, PlacedEdge, PlacedNode, Point } from './types'

/**
 * Runs ELK over a diagram. Every group is laid out on its own with its own
 * algorithm (ELK's default SEPARATE_CHILDREN), so only edges between
 * siblings are routed. With `linkedLayout`, the top-level boxes that edges
 * across group borders join go into an invisible box that ELK lays out as
 * one graph (INCLUDE_CHILDREN), so those edges are routed too; everything
 * else keeps its own layout. Without it, such edges are left without points
 * and drawn as plain curves by the renderer.
 */
export async function layoutDiagram(diagram: Diagram, elk: ELK): Promise<Layout> {
  const root: ElkNode = {
    id: '__root',
    layoutOptions: { ...diagram.rootLayout, 'elk.json.edgeCoords': 'ROOT', 'elk.json.shapeCoords': 'PARENT' },
    children: [],
    edges: [],
  }
  const { top, cluster } = linkedBoxes(diagram)
  const elkNodes = new Map<string, ElkNode>([[root.id, root]])
  for (const c of new Set(cluster.values())) {
    const layoutOptions = {
      ...diagram.linkedLayout,
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.padding': '[top=0,left=0,bottom=0,right=0]',
    }
    elkNodes.set(c, { id: c, layoutOptions, children: [], edges: [] })
  }
  const entered = enteredGroups(diagram)
  for (const n of diagram.nodes) {
    // A group in a linked box is part of its graph: same algorithm, own padding.
    // One no routed line enters (a packed server group, lines end at its box)
    // keeps its own algorithm; ELK lays it out on its own first.
    const padding = n.layout?.['elk.padding']
    const linked = cluster.has(top(n.id)) && (n.type !== 'group' || entered.has(n.id))
    const options = linked ? { ...diagram.linkedLayout, ...(padding ? { 'elk.padding': padding } : {}) } : (n.layout ?? {})
    // ELK's JSON importer chokes on keys that are present but undefined.
    elkNodes.set(
      n.id,
      n.type === 'group' ? { id: n.id, layoutOptions: options, children: [], edges: [] } : { id: n.id, width: n.width!, height: n.height! },
    )
  }
  for (const n of diagram.nodes) {
    // A linked box takes the place of its first member, keeping the model order.
    const linked = !n.parent && cluster.get(n.id)
    if (linked && !elkNodes.get(linked)!.children!.length) root.children!.push(elkNodes.get(linked)!)
    const parent = elkNodes.get(n.parent ?? (linked || root.id))
    if (!parent?.children) throw new Error(`diagram node ${n.id}: parent ${n.parent} is not a group`)
    parent.children.push(elkNodes.get(n.id)!)
  }

  const parentOf = new Map(diagram.nodes.map((n) => [n.id, n.parent ?? root.id]))
  const order = new Map(diagram.nodes.map((n, i) => [n.id, i]))
  const routed = new Set<string>()
  const flipped = new Set<string>()
  for (const e of routedEdges(diagram)) {
    const p = parentOf.get(e.source)
    // Two top-level boxes a line joins are in one linked box (the root routes nothing).
    if (p === parentOf.get(e.target) && !(p === root.id && cluster.has(e.source))) {
      elkNodes.get(p!)!.edges!.push({ id: e.id, sources: [e.source], targets: [e.target] })
    } else {
      // Lines between groups have no direction worth keeping; pointing them all
      // from the earlier group to the later one lets ELK put the groups in that
      // order instead of looping lines that point back round both groups.
      const flip = !diagram.directed && order.get(top(e.source))! > order.get(top(e.target))!
      if (flip) flipped.add(e.id)
      const [a, b] = flip ? [e.target, e.source] : [e.source, e.target]
      elkNodes.get(cluster.get(top(e.source))!)!.edges!.push({ id: e.id, sources: [a], targets: [b] })
    }
    routed.add(e.id)
  }

  const result = await elk.layout(root)

  const byId = new Map(diagram.nodes.map((d) => [d.id, d]))
  const nodes: PlacedNode[] = []
  const edges = new Map<string, Point[]>()
  // Boxes in a linked box are placed relative to it; it is not drawn, so they move to the top level.
  const visit = (n: ElkNode, dx = 0, dy = 0) => {
    for (const c of n.children ?? []) {
      const d = byId.get(c.id)
      const [x, y] = [(c.x ?? 0) + dx, (c.y ?? 0) + dy]
      if (!d) {
        visit(c, x, y)
        continue
      }
      nodes.push({ ...d, x, y, width: c.width ?? d.width ?? 0, height: c.height ?? d.height ?? 0 })
      visit(c)
    }
    for (const e of (n.edges ?? []) as ElkExtendedEdge[]) {
      const s = e.sections?.[0]
      if (!s) continue
      const points = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]
      edges.set(e.id, flipped.has(e.id) ? points.reverse() : points)
    }
  }
  visit(result)
  // Parents first, as React Flow requires.
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

/**
 * With `linkedLayout`: the top-level boxes that routed edges across group
 * borders (or between two top-level boxes) join, each mapped to the id of its linked box (boxes joined by
 * such edges, directly or through others, share one). `top` gives the
 * top-level box a node sits in.
 */
export function linkedBoxes(diagram: Diagram) {
  const parentOf = new Map(diagram.nodes.map((n) => [n.id, n.parent]))
  const top = (id: string): string => {
    const p = parentOf.get(id)
    return p ? top(p) : id
  }
  const cluster = new Map<string, string>()
  if (!diagram.linkedLayout) return { top, cluster }
  const joined = new Map<string, string>()
  const find = (id: string): string => {
    const p = joined.get(id) ?? id
    return p === id ? id : find(p)
  }
  const across = routedEdges(diagram).filter((e) => parentOf.get(e.source) !== parentOf.get(e.target) || !parentOf.get(e.source))
  for (const e of across) {
    const [a, b] = [find(top(e.source)), find(top(e.target))]
    if (a !== b) joined.set(b, a)
  }
  for (const e of across) for (const id of [top(e.source), top(e.target)]) cluster.set(id, `__linked:${find(id)}`)
  return { top, cluster }
}

/** Groups that a routed edge enters: one of its ends lies inside the group. */
function enteredGroups(diagram: Diagram) {
  const parentOf = new Map(diagram.nodes.map((n) => [n.id, n.parent]))
  const out = new Set<string>()
  for (const e of routedEdges(diagram)) {
    for (const end of [e.source, e.target]) for (let p = parentOf.get(end); p && !out.has(p); p = parentOf.get(p)) out.add(p)
  }
  return out
}

/** Absolute position of every node/** Absolute position of every node (layout positions are relative to the parent). */
export function absolutePositions(layout: Layout): Map<string, Point & { width: number; height: number }> {
  const out = new Map<string, Point & { width: number; height: number }>()
  for (const n of layout.nodes) {
    const p = n.parent ? out.get(n.parent) : undefined
    out.set(n.id, { x: n.x + (p?.x ?? 0), y: n.y + (p?.y ?? 0), width: n.width, height: n.height })
  }
  return out
}

/**
 * Edges ELK routes: always drawn, and both ends in the same group (or both
 * top level), or anywhere with `linkedLayout`.
 */
function routedEdges(diagram: Diagram) {
  const parentOf = new Map(diagram.nodes.map((n) => [n.id, n.parent ?? '']))
  return diagram.edges.filter(
    (e) =>
      !e.onDemand &&
      parentOf.has(e.source) &&
      parentOf.has(e.target) &&
      (!!diagram.linkedLayout || parentOf.get(e.source) === parentOf.get(e.target)),
  )
}

/**
 * Everything the layout depends on, as a string: node ids, types, parents,
 * sizes and ELK options in diagram order (ELK keeps the model order), plus
 * the edges ELK routes (they also decide the linked boxes). Titles, pills,
 * tags and change markers only affect rendering, so diagrams that differ in
 * those share a layout.
 */
export function layoutSignature(diagram: Diagram): string {
  return JSON.stringify([
    diagram.key,
    diagram.rootLayout,
    diagram.linkedLayout ?? null,
    !!diagram.directed,
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
