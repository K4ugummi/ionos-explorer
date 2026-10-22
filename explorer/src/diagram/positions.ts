import type { Box } from './framing'
import { absolutePositions } from './layout'
import type { DiagramNode, Layout, PlacedEdge, Point } from './types'

/**
 * Own positions: boxes the user dragged, kept as offsets from where the
 * automatic layout puts them (annotations, `positions`). They are applied to
 * a finished layout, so moving a box never lays the view out again, and a
 * layout with new resources keeps the user's intention roughly.
 */
export interface Offset {
  dx: number
  dy: number
}

export type Offsets = ReadonlyMap<string, Offset>

export const NO_OFFSETS: Offsets = new Map()

/**
 * Boxes the user may move: top-level boxes and groups, and boxes in a group
 * ELK lays out as a graph (datacenter cards and hubs in a location). Not
 * the members of a packed group (servers in a server group, leftovers,
 * endpoints outside) nor its "+N more" box: they keep their grid, and the
 * group moves as a whole.
 */
export function movable(nodes: readonly DiagramNode[]): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const packed = (id?: string) => !!id && byId.get(id)?.layout?.['elk.algorithm'] === 'rectpacking'
  return new Set(nodes.filter((n) => n.type !== 'member' && n.type !== 'more' && !packed(n.parent)).map((n) => n.id))
}

/**
 * The layout with the user's offsets applied. A moved box takes what is
 * inside it along; a group with a moved box inside is drawn around its
 * contents (it grows or shrinks; its padding stays). Offsets for boxes
 * this layout does not have, or may not move, are ignored. Routed edges
 * whose ends moved apart lose their points (`moved`, drawn as plain steps
 * between the boxes); edges whose ends moved together keep their route,
 * shifted along.
 */
export function applyPositions(layout: Layout, offsets: Offsets): Layout {
  const can = movable(layout.nodes)
  const own = new Map([...offsets].filter(([id, o]) => can.has(id) && (o.dx || o.dy)))
  if (!own.size) return layout
  const byId = new Map(layout.nodes.map((n) => [n.id, n]))
  const elk = absolutePositions(layout)

  // How far each box moves: its own offset and its groups'. Parents come first.
  const shift = new Map<string, Point>()
  for (const n of layout.nodes) {
    const p = (n.parent && shift.get(n.parent)) || { x: 0, y: 0 }
    const o = own.get(n.id)
    shift.set(n.id, o ? { x: p.x + o.dx, y: p.y + o.dy } : p)
  }
  // Groups with a moved box somewhere inside are drawn around their contents.
  const rearranged = new Set<string>()
  for (const id of own.keys()) for (let p = byId.get(id)?.parent; p && !rearranged.has(p); p = byId.get(p)?.parent) rearranged.add(p)
  const inside = (id: string, group: string) => {
    for (let p = byId.get(id)?.parent; p; p = byId.get(p)?.parent) if (p === group) return true
    return false
  }

  const edges = layout.edges.map((e): PlacedEdge => {
    const [s, t] = [shift.get(e.source), shift.get(e.target)]
    if (!e.points || !s || !t) return e
    if (s.x === t.x && s.y === t.y && !rearranged.has(e.source) && !rearranged.has(e.target)) {
      return s.x || s.y ? { ...e, points: e.points.map((p) => ({ x: p.x + s.x, y: p.y + s.y })) } : e
    }
    const { points: _, ...rest } = e
    return { ...rest, moved: true }
  })

  const box = new Map<string, Box>()
  for (const n of layout.nodes) {
    const [a, s] = [elk.get(n.id)!, shift.get(n.id)!]
    box.set(n.id, { x: a.x + s.x, y: a.y + s.y, width: a.width, height: a.height })
  }
  // Innermost groups first (the layout lists parents before children).
  for (const g of [...layout.nodes].reverse()) {
    if (!rearranged.has(g.id)) continue
    const parts: Box[] = layout.nodes.filter((n) => n.parent === g.id).map((n) => box.get(n.id)!)
    for (const e of edges) {
      if (e.points && inside(e.source, g.id) && inside(e.target, g.id)) parts.push(...e.points.map((p) => ({ ...p, width: 0, height: 0 })))
    }
    if (!parts.length) continue
    const pad = padding(g.layout?.['elk.padding'])
    const [x0, y0] = [Math.min(...parts.map((b) => b.x)), Math.min(...parts.map((b) => b.y))]
    const [x1, y1] = [Math.max(...parts.map((b) => b.x + b.width)), Math.max(...parts.map((b) => b.y + b.height))]
    box.set(g.id, { x: x0 - pad.left, y: y0 - pad.top, width: x1 - x0 + pad.left + pad.right, height: y1 - y0 + pad.top + pad.bottom })
  }

  return {
    ...layout,
    nodes: layout.nodes.map((n) => {
      const b = box.get(n.id)!
      const p = n.parent ? box.get(n.parent) : undefined
      return { ...n, x: b.x - (p?.x ?? 0), y: b.y - (p?.y ?? 0), width: b.width, height: b.height }
    }),
    edges,
  }
}

/**
 * The offset that puts a box at `at` (absolute), given where it is drawn now
 * (`drawn`, with `offsets` applied). Moving a box by its offset moves its
 * drawn outline by the same amount, groups that were drawn around their
 * contents included.
 */
export function offsetTo(drawn: ReadonlyMap<string, Point>, offsets: Offsets, id: string, at: Point): Offset {
  const now = drawn.get(id) ?? at
  const o = offsets.get(id) ?? { dx: 0, dy: 0 }
  return { dx: o.dx + at.x - now.x, dy: o.dy + at.y - now.y }
}

/** ELK's `elk.padding` ("[top=40,left=16,bottom=16,right=16]"); ELK's default of 12 where missing. */
export function padding(value?: string) {
  const get = (side: string) => Number(value?.match(new RegExp(`${side}=(-?[\\d.]+)`))?.[1] ?? 12)
  return { top: get('top'), left: get('left'), bottom: get('bottom'), right: get('right') }
}

/** The background's dot spacing; with snapping on, a dropped box's top left corner lands on a dot. */
export const GRID = 20

export function snapToGrid(p: Point, grid = GRID): Point {
  return { x: Math.round(p.x / grid) * grid, y: Math.round(p.y / grid) * grid }
}

/**
 * The boxes a drag moves: the one held, or with a selection of several
 * boxes (`picked`) that includes it, all of them. A box inside another
 * moving box is left out: it goes along with its group anyway.
 */
export function movingWith(held: string, picked: ReadonlySet<string>, nodes: readonly DiagramNode[]): Set<string> {
  if (!picked.has(held) || picked.size < 2) return new Set([held])
  const parent = new Map(nodes.map((n) => [n.id, n.parent]))
  const inMoving = (id: string) => {
    for (let p = parent.get(id); p; p = parent.get(p)) if (picked.has(p)) return true
    return false
  }
  return new Set([...picked].filter((id) => parent.has(id) && !inMoving(id)))
}

const SNAP_KEY = 'ionos-explorer:snap'

export function loadSnap(): boolean {
  try {
    return localStorage.getItem(SNAP_KEY) === '1'
  } catch {
    return false
  }
}

export function saveSnap(on: boolean) {
  try {
    if (on) localStorage.setItem(SNAP_KEY, '1')
    else localStorage.removeItem(SNAP_KEY)
  } catch {
    // Storage disabled: the choice lasts as long as the page.
  }
}
