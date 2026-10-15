import { KINDS, subtypeLabel } from './kinds'
import type { EdgeKind, GraphNode, Model, NodeKind } from './types'

/*
 * The network as a graph: what is connected to what, across datacenters,
 * and how one resource reaches another. Edges are treated as undirected.
 * NICs and volumes are not part of it: a server stands for its NICs.
 */

/** Resources that are nodes of the network graph. */
export const NETWORK_KINDS: ReadonlySet<NodeKind> = new Set([
  'server',
  'lan',
  'pcc',
  'natgateway',
  'vpngateway',
  'nlb',
  'alb',
  'nodepool',
  'postgres',
  'external',
])

/**
 * What may sit in the middle of a path. LANs and Cross Connects carry
 * traffic; load balancers and VPN gateways forward it; an endpoint outside
 * the contract (a site, a VPN peer) is usually a firewall that does too.
 * Servers route only as appliances (see `transitCost`). NAT gateways,
 * node pools and databases end a path.
 */
const LOAD_BALANCERS: ReadonlySet<NodeKind> = new Set(['nlb', 'alb'])

const TRANSIT: ReadonlySet<NodeKind> = new Set(['lan', 'pcc', 'nlb', 'alb', 'vpngateway', 'external', 'server'])

/**
 * Extra cost of routing through a server that was not detected as a network
 * appliance: a multi-homed server sits in both LANs, but it only forwards
 * if someone set it up to. Large enough that any route through appliances
 * wins, whatever its length.
 */
export const PLAIN_SERVER_COST = 1000

export interface NetEdge {
  /** The other end. */
  to: string
  kind: EdgeKind
  /** The model edge's label (an IP, a port, a link label). */
  label?: string
  /** VPN tunnels: the tunnel node; manual links: the annotation id. */
  ref?: string
  /** True when the model edge points from this end to the other. */
  out: boolean
}

export type NetGraph = Map<string, NetEdge[]>

const graphs = new WeakMap<Model, NetGraph>()

/** The network graph of a model (cached per model object). */
export function networkGraph(model: Model): NetGraph {
  let g = graphs.get(model)
  if (g) return g
  g = new Map()
  const graph = g
  const add = (from: string, to: string, kind: EdgeKind, label?: string, ref?: string) => {
    const [a, b] = [model.nodes.get(from), model.nodes.get(to)]
    if (!a || !b || a.id === b.id || !NETWORK_KINDS.has(a.kind) || !NETWORK_KINDS.has(b.kind)) return
    // One edge per pair: a server with two NICs in a LAN, a balancer listening and targeting there.
    if (graph.get(a.id)?.some((e) => e.to === b.id)) return
    graph.set(a.id, [...(graph.get(a.id) ?? []), { to: b.id, kind, label, ref, out: true }])
    graph.set(b.id, [...(graph.get(b.id) ?? []), { to: a.id, kind, label, ref, out: false }])
  }
  // Target groups stand between an application load balancer and its servers.
  const albsOf = new Map<string, string[]>()
  for (const e of model.edges) if (e.kind === 'forwards-to') albsOf.set(e.to, [...(albsOf.get(e.to) ?? []), e.from])
  for (const e of model.edges) {
    switch (e.kind) {
      case 'member':
      case 'cross-connect':
      case 'listener':
      case 'target-lan':
      case 'gateway':
      case 'connection':
      case 'manual':
        add(e.from, e.to, e.kind, e.label, e.ref)
        break
      case 'target':
        for (const lb of albsOf.get(e.from) ?? [e.from]) add(lb, e.to, e.kind, e.label)
        break
      case 'tunnel': {
        // Drawn from the gateway, like the diagram does; the tunnel itself is no node.
        const gw = model.nodes.get(model.nodes.get(e.from)?.parentId ?? '')
        if (gw?.kind === 'vpngateway') add(gw.id, e.to, e.kind, model.nodes.get(e.from)!.name, e.from)
        break
      }
    }
  }
  for (const list of graph.values()) list.sort((x, y) => byName(model, x.to, y.to))
  graphs.set(model, graph)
  return graph
}

const twinCache = new WeakMap<Model, Map<string, string>>()

/**
 * Nodes that are interchangeable on any path, mapped to the first of them by
 * name: same kind, both appliances or neither, and the same neighbours (the
 * two firewalls of a pair, the members of a web farm).
 */
function twins(model: Model): Map<string, string> {
  let out = twinCache.get(model)
  if (out) return out
  out = new Map()
  const first = new Map<string, string>()
  const graph = networkGraph(model)
  for (const id of [...graph.keys()].sort((x, y) => byName(model, x, y))) {
    const n = model.nodes.get(id)!
    const key = [
      n.kind,
      !!n.appliance,
      ...graph
        .get(id)!
        .map((e) => e.to)
        .sort(),
    ].join('|')
    const rep = first.get(key)
    if (rep) out.set(id, rep)
    else first.set(key, id)
  }
  twinCache.set(model, out)
  return out
}

const byName = (model: Model, a: string, b: string) =>
  (model.nodes.get(a)?.name ?? a).localeCompare(model.nodes.get(b)?.name ?? b, undefined, { numeric: true }) || a.localeCompare(b)

/**
 * The network node that stands for a resource: itself, or for a NIC its
 * server, for a volume the server it is attached to, for a VPN tunnel its
 * gateway. Undefined for anything else (datacenters, images, …).
 */
export function networkNode(model: Model, id: string): string | undefined {
  const n = model.nodes.get(id)
  if (!n) return undefined
  if (NETWORK_KINDS.has(n.kind)) return n.id
  if (n.kind === 'nic' || n.kind === 'vpntunnel') return n.parentId && networkNode(model, n.parentId)
  if (n.kind === 'volume') {
    const server = (model.edgesByNode.get(id) ?? []).find((e) => e.kind === 'attached' && e.to === id)?.from
    return server && networkNode(model, server)
  }
  return undefined
}

export const DEFAULT_HOPS = 2
export const MAX_HOPS = 3

/**
 * Everything within `hops` steps of a resource, with its distance, across
 * datacenters. Every node on the way counts as a step: a LAN, a Cross
 * Connect, a server (NICs do not). From a server, 1 is its LANs, 2 what
 * else sits on them and their Cross Connects. Empty if the resource is not
 * part of the network.
 */
export function neighbourhood(model: Model, id: string, hops = DEFAULT_HOPS): Map<string, number> {
  const graph = networkGraph(model)
  const start = networkNode(model, id)
  const out = new Map<string, number>()
  if (!start) return out
  out.set(start, 0)
  let frontier = [start]
  for (let d = 1; d <= hops && frontier.length; d++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const e of graph.get(id) ?? []) {
        if (out.has(e.to)) continue
        out.set(e.to, d)
        next.push(e.to)
      }
    }
    frontier = next
  }
  return out
}

export interface Path {
  /** Model node ids from the start to the end. */
  nodes: string[]
  /** The edge between `nodes[i]` and `nodes[i + 1]`, seen from `nodes[i]`. */
  edges: NetEdge[]
  /**
   * Per node, others that could take its place: they join the same two
   * neighbours at the same cost (the second firewall of a pair, a second
   * LAN both ends sit in). Empty at the ends. Paths that differ only by
   * such a node are one path.
   */
  alternatives: string[][]
  /** Servers in the middle that are not known appliances: the route holds only if they forward. */
  plain: string[]
}

/** Extra cost of passing through a node, or undefined if a path may not pass through it. */
function transitCost(model: Model, id: string): number | undefined {
  const n = model.nodes.get(id)
  if (!n || !TRANSIT.has(n.kind)) return undefined
  if (n.kind !== 'server') return 0
  return n.appliance ? 0 : PLAIN_SERVER_COST
}

/**
 * The shortest paths from one resource to another, at most `max`, without
 * a node twice. Shortest by hop count, but a path through a server that is
 * not a detected appliance counts as much longer, so routes through
 * firewalls and routers come first and other multi-homed servers are
 * a last resort (each is listed in `plain`). Dijkstra, then Yen's
 * algorithm for the next ones. A path that only swaps a node for a
 * parallel one is not counted again (see `alternatives`), and one with a
 * shortcut (two of its nodes are neighbours: in from a firewall's LAN, out
 * through its partner) is left out. Paths go from `from` to `to`, which
 * matters only for load balancers. Empty when there is no way at all.
 */
export function findPaths(model: Model, from: string, to: string, { max = 3 } = {}): Path[] {
  // The details panel and the canvas ask for the same paths.
  const cache = pathCache.get(model) ?? new Map<string, Path[]>()
  pathCache.set(model, cache)
  const key = `${from}>${to}>${max}`
  if (!cache.has(key)) cache.set(key, search(model, from, to, max))
  return cache.get(key)!
}

const pathCache = new WeakMap<Model, Map<string, Path[]>>()

function search(model: Model, from: string, to: string, max: number): Path[] {
  const graph = networkGraph(model)
  const [a, b] = [networkNode(model, from), networkNode(model, to)]
  if (!a || !b || a === b) return []
  const cost = new Map<string, number | undefined>()
  const through = (id: string) => {
    if (!cost.has(id)) cost.set(id, transitCost(model, id))
    return cost.get(id)
  }
  // Of twins (an HA pair, a server farm) only the first is searched through;
  // the others come back as its alternatives. Without that, every route
  // would be found once per twin.
  const twin = twins(model)
  const enter = (id: string) => (twin.has(id) ? undefined : through(id))

  /** Cheapest path from `start` to b avoiding these nodes and edges; [] if none. */
  const kindOf = (x: string, y: string) => graph.get(x)!.find((e) => e.to === y)!.kind
  /**
   * A load balancer forwards from its listener LAN to its targets, so a path
   * (from the side that starts the traffic) goes in there and out to a target.
   */
  const passes = (via: string, from: string | undefined, to: string) => {
    if (!from || !LOAD_BALANCERS.has(model.nodes.get(via)!.kind)) return true
    return kindOf(via, from) === 'listener' && kindOf(via, to) !== 'listener'
  }

  /** Cheapest path from `start` (reached from `before`) to b avoiding these nodes and edges; [] if none. */
  const shortest = (start: string, avoidNodes: Set<string>, avoidEdges: Set<string>, before?: string): string[] => {
    const dist = new Map<string, number>([[start, 0]])
    const prev = new Map<string, string>(before ? [[start, before]] : [])
    const done = new Set<string>()
    const open = heap()
    open.push(0, start)
    while (open.size()) {
      const [best, cur] = open.pop()
      if (done.has(cur)) continue
      if (cur === b) break
      done.add(cur)
      // Only the start and the end may be anything; the middle must carry traffic.
      if (cur !== start && enter(cur) === undefined) continue
      for (const e of graph.get(cur) ?? []) {
        if (done.has(e.to) || avoidNodes.has(e.to) || avoidEdges.has(`${cur}|${e.to}`) || !passes(cur, prev.get(cur), e.to)) continue
        const step = e.to === b ? 1 : 1 + (enter(e.to) ?? Infinity)
        const d = best + step
        if (d < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, d)
          prev.set(e.to, cur)
          open.push(d, e.to)
        }
      }
    }
    if (!dist.has(b)) return []
    const out = [b]
    while (out[0] !== start) out.unshift(prev.get(out[0])!)
    return out
  }

  const weight = (p: string[]) => p.slice(1, -1).reduce((s, id) => s + 1 + through(id)!, 1)
  /** Per position, other nodes that join the same neighbours at the same cost (the other firewall of a pair). */
  const parallels = (p: string[]) =>
    p.map((id, i) => {
      if (i === 0 || i === p.length - 1) return []
      const out = (graph.get(p[i - 1]) ?? [])
        .map((e) => e.to)
        .filter(
          (z) =>
            z !== id &&
            !p.includes(z) &&
            through(z) === through(id) &&
            graph.get(z)!.some((e) => e.to === p[i + 1]) &&
            passes(z, p[i - 1], p[i + 1]),
        )
      return out
    })
  /**
   * A path two of whose nodes are neighbours in the graph has a shorter way
   * round; it is not shown. Except the two ends: with a direct link between
   * them, a route through the network is still another way.
   */
  const shortcut = (p: string[]) =>
    p.some((id, i) => graph.get(id)!.some((e) => p.indexOf(e.to) > i + 1 && !(i === 0 && e.to === p[p.length - 1])))
  const first = shortest(a, new Set(), new Set())
  if (!first.length) return []
  // Every path taken, also those that differ from a shown one only by a
  // parallel node: Yen's algorithm needs them to block their edges.
  const taken: string[][] = [first]
  // Where each taken path left the one it was found from: earlier spurs were tried already (Lawler).
  const deviation = new Map<string[], number>([[first, 0]])
  const shown = [{ nodes: first, alternatives: parallels(first) }]
  const key = (p: string[]) => p.join('>')
  const seen = new Set([key(first)])
  const candidates: { path: string[]; from: number }[] = []
  const same = (s: (typeof shown)[number], p: string[]) =>
    s.nodes.length === p.length && p.every((id, i) => id === s.nodes[i] || s.alternatives[i].includes(id))
  while (shown.length < max && taken.length < max * 8) {
    const last = taken[taken.length - 1]
    for (let i = deviation.get(last)!; i < last.length - 1; i++) {
      const root = last.slice(0, i + 1)
      const avoidEdges = new Set<string>()
      for (const p of taken) {
        if (p.length > i && key(p.slice(0, i + 1)) === key(root)) {
          avoidEdges.add(`${p[i]}|${p[i + 1]}`).add(`${p[i + 1]}|${p[i]}`)
        }
      }
      const spur = shortest(last[i], new Set(root.slice(0, -1)), avoidEdges, root[i - 1])
      if (!spur.length) continue
      const path = [...root.slice(0, -1), ...spur]
      if (seen.has(key(path))) continue
      seen.add(key(path))
      candidates.push({ path, from: i })
    }
    if (!candidates.length) break
    // Cheapest next; on a tie the shorter, then in the order found (neighbours go by name).
    candidates.sort((x, y) => weight(x.path) - weight(y.path) || x.path.length - y.path.length)
    const { path: next, from: at } = candidates.shift()!
    deviation.set(next, at)
    taken.push(next)
    if (!shortcut(next) && !shown.some((s) => same(s, next))) shown.push({ nodes: next, alternatives: parallels(next) })
  }
  return shown.map(({ nodes, alternatives }) => ({
    nodes,
    edges: nodes.slice(0, -1).map((id, i) => graph.get(id)!.find((e) => e.to === nodes[i + 1])!),
    alternatives,
    plain: nodes.slice(1, -1).filter((id) => through(id)! > 0),
  }))
}

/** "fra-core-fw-01 (likely firewall or VPN gateway)", "txl-core-vpn-01 (Cisco Catalyst 8000V)". */
function routerName(n: GraphNode) {
  const a = n.appliance
  if (!a) return n.name
  // Products keep their capitals; "Likely …" and "Possible …" read on in lower case.
  return `${n.name} (${a.confidence === 'high' ? a.title : a.title.charAt(0).toLowerCase() + a.title.slice(1)})`
}

const dcName = (model: Model, n: GraphNode) => (n.dcId && n.dcId !== n.id ? model.nodes.get(n.dcId)?.name : undefined)

/**
 * Each step of a path in words, one per edge: "member of LAN app",
 * "Cross Connect fra-backbone to fra-prod-data", "routed by
 * fra-core-fw-01 (likely firewall or VPN gateway)".
 */
export function describePath(model: Model, path: Path): string[] {
  const node = (i: number) => model.nodes.get(path.nodes[i])!
  const last = path.nodes.length - 1
  return path.edges.map((e, i) => {
    const alts = path.alternatives[i + 1] ?? []
    const or = alts.length ? `, or ${alts.map((id) => model.nodes.get(id)!.name).join(', ')}` : ''
    return step(e, i) + or
  })

  function step(e: NetEdge, i: number) {
    const [x, y] = [node(i), node(i + 1)]
    const lan = (n: GraphNode) =>
      `LAN ${n.name}${dcName(model, n) && dcName(model, n) !== dcName(model, x) ? ` in ${dcName(model, n)}` : ''}`
    switch (e.kind) {
      case 'cross-connect': {
        if (y.kind === 'pcc') {
          // Named after where it leads: the datacenter of the LAN after it.
          const next = i + 2 <= last ? node(i + 2) : undefined
          const there = next && dcName(model, next) !== dcName(model, x) ? dcName(model, next) : undefined
          return `Cross Connect ${y.name}${there ? ` to ${there}` : ''}`
        }
        return `into ${lan(y)}`
      }
      case 'tunnel':
        return `VPN tunnel ${e.label ?? ''} to ${y.name}`.replace('  ', ' ')
      case 'manual':
        return `manual link${e.label ? ` "${e.label}"` : ''} to ${y.name}`
      case 'target':
        return y.kind === 'server' ? `load balanced to ${y.name}${e.label ? ` (${e.label})` : ''}` : `target of ${y.name}`
    }
    // Into a LAN, or from a LAN to what sits on it.
    if (y.kind === 'lan') {
      const how = {
        member: 'member of',
        gateway: 'NAT gateway for',
        connection: 'connected to',
        listener: 'listens in',
        'target-lan': 'targets in',
      }
      return `${how[e.kind as keyof typeof how] ?? 'in'} ${lan(y)}`
    }
    if (i + 1 === last) return `to ${y.name}${e.label ? ` (${e.label})` : ''}`
    if (y.kind === 'server') return y.appliance ? `routed by ${routerName(y)}` : `through ${y.name} (in both LANs; only if it forwards)`
    if (y.kind === 'external') return `through ${y.name} (outside the contract)`
    return `through ${KINDS[y.kind].label} ${y.name}`
  }
}

/** One line on what a node is, for lists of steps: "Cube server · fra-prod-core". */
export function nodeLine(model: Model, n: GraphNode) {
  return [subtypeLabel(n.kind, n.subtype) ?? KINDS[n.kind].label, dcName(model, n)].filter(Boolean).join(' · ')
}

/**
 * A binary min-heap of [cost, id]; entries are never updated, stale ones
 * are skipped by the caller. Equal costs come out in the order they went in,
 * so ties go to the neighbour first by name, as in a breadth-first search.
 */
function heap() {
  const items: [number, string, number][] = []
  let order = 0
  const less = (i: number, j: number) => items[i][0] < items[j][0] || (items[i][0] === items[j][0] && items[i][2] < items[j][2])
  const swap = (i: number, j: number) => ([items[i], items[j]] = [items[j], items[i]])
  return {
    size: () => items.length,
    push(cost: number, id: string) {
      items.push([cost, id, order++])
      for (let i = items.length - 1; i > 0 && less(i, (i - 1) >> 1); i = (i - 1) >> 1) swap(i, (i - 1) >> 1)
    },
    pop(): [number, string] {
      const [cost, id] = items[0]
      const last = items.pop()!
      if (items.length) {
        items[0] = last
        for (let i = 0; ;) {
          const [l, r] = [2 * i + 1, 2 * i + 2]
          let m = i
          if (l < items.length && less(l, m)) m = l
          if (r < items.length && less(r, m)) m = r
          if (m === i) break
          swap(i, m)
          i = m
        }
      }
      return [cost, id]
    },
  }
}
