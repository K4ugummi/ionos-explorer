import { countsText } from '../diff/diff'
import { MANY_LANS } from '../model/appliances'
import { KINDS, LAN_SERVICES, subtypeLabel } from '../model/kinds'
import { DEFAULT_HOPS, neighbourhood, networkGraph, networkNode, type NetEdge, type Path } from '../model/paths'
import type { GraphEdge, GraphNode, Model, NodeKind } from '../model/types'
import { hiddenKind, type Layer } from './layers'
import type { Diagram, DiagramEdge, DiagramNode, NodeData } from './types'

// Fixed node sizes; the renderer uses the same numbers.
export const SIZE = {
  dc: { width: 260, height: 112 },
  hub: { width: 220, height: 52 },
  peer: { width: 220, height: 52 },
  resource: { width: 236, height: 54 },
  router: { width: 280, height: 72 },
  member: { width: 196, height: 42 },
  internet: { width: 180, height: 44 },
  external: { width: 210, height: 52 },
  lanHeight: 44,
} as const

const LAYERED = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.spacing.nodeNodeBetweenLayers': '64',
  'elk.layered.spacing.edgeNodeBetweenLayers': '24',
  'elk.spacing.nodeNode': '28',
  'elk.spacing.edgeNode': '18',
  'elk.spacing.edgeEdge': '10',
  'elk.spacing.componentComponent': '48',
  'elk.separateConnectedComponents': 'true',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
}

/**
 * Locations joined by lines (tunnels, manual links, Cross Connects across
 * locations) are laid out as one graph so ELK routes those lines around the
 * cards. ELK cannot keep the model order or pack components in that mode.
 */
const LINKED = { ...LAYERED, 'elk.layered.considerModelOrder.strategy': 'NONE', 'elk.separateConnectedComponents': 'false' }

const GROUP_PADDING = '[top=40,left=16,bottom=16,right=16]'

/** Children of a server group: packed into a grid. */
const PACKED = {
  'elk.algorithm': 'rectpacking',
  'elk.padding': '[top=34,left=10,bottom=10,right=10]',
  'elk.spacing.nodeNode': '8',
  'elk.aspectRatio': '2.2',
}

const ACTIVE_STATES = new Set(['AVAILABLE', 'RUNNING', 'ACTIVE', 'DEPLOYED', 'BUSY'])

const byName = (a: GraphNode, b: GraphNode) => a.name.localeCompare(b.name, undefined, { numeric: true })

const isInactive = (n: GraphNode) => !!n.state && !ACTIVE_STATES.has(n.state.toUpperCase())

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const fact = (n: GraphNode, label: string) => n.facts.find((f) => f.label === label)?.value

const NO_LAYERS: ReadonlySet<Layer> = new Set()

function base(n: GraphNode): NodeData {
  const a = n.appliance
  return {
    title: n.name,
    kind: n.kind,
    inactive: isInactive(n),
    placeholder: n.placeholder || undefined,
    tag: a ? (a.confidence === 'high' ? a.title : 'appliance?') : undefined,
    tagLevel: a?.confidence,
    change: n.change,
    changes: n.changeCounts ? countsText(n.changeCounts) || undefined : undefined,
  }
}

function subtitle(n: GraphNode): string {
  const what =
    n.kind === 'nodepool'
      ? `${KINDS.nodepool.label}${fact(n, 'Nodes') ? ` · ${plural(Number(fact(n, 'Nodes')), 'node')}` : ''}`
      : LAN_SERVICES.has(n.kind)
        ? `${LAN_SERVICES.get(n.kind)} ${fact(n, LAN_SERVICES.get(n.kind)!) ?? ''}`.trim()
        : n.kind === 'vpngateway'
          ? `${n.subtype ?? ''} VPN gateway`.trim()
          : (subtypeLabel(n.kind, n.subtype) ?? KINDS[n.kind].label)
  return [what, ipLabel(n)].filter(Boolean).join(' · ')
}

/** The first IP; ✎ marks one the user corrected (IONOS has another on record). */
function ipLabel(n: GraphNode) {
  const ip = n.ips[0]
  return ip && n.ionosIps && !n.ionosIps.includes(ip) ? `${ip} ✎` : ip
}

function pccSubtitle(pcc: GraphNode, dcs: number) {
  if (pcc.subtype === 'unused') return 'no LAN connected'
  if (pcc.subtype === 'one LAN') return 'only 1 LAN connected'
  return dcs ? plural(dcs, 'datacenter') : 'peers not in this snapshot'
}

/** Cross Connect → the LANs it joins, grouped by datacenter. */
function pccPeers(model: Model, pccId: string): Map<string, GraphNode[]> {
  const out = new Map<string, GraphNode[]>()
  for (const e of model.edgesByNode.get(pccId) ?? []) {
    if (e.kind !== 'cross-connect' || e.to !== pccId) continue
    const lan = model.nodes.get(e.from)
    if (!lan?.dcId) continue
    out.set(lan.dcId, [...(out.get(lan.dcId) ?? []), lan])
  }
  return out
}

function nodesOf(model: Model, kind: NodeKind) {
  return [...model.nodes.values()].filter((n) => n.kind === kind)
}

function externalNode(n: GraphNode, id: string, parent?: string): DiagramNode {
  const hosts = n.subtype === 'Site' ? fact(n, 'Hosts') : undefined
  return {
    id,
    type: 'external',
    parent,
    ref: n.id,
    ...SIZE.external,
    data: { ...base(n), subtitle: [n.subtype, hosts].filter(Boolean).join(' · ') },
  }
}

/** VPN tunnels and manual links with the model nodes at their two ends. */
function links(model: Model) {
  const out: { kind: 'tunnel' | 'manual'; from: GraphNode; to: GraphNode; id: string; label?: string; ref: string }[] = []
  for (const e of model.edges) {
    const [a, b] = [model.nodes.get(e.from), model.nodes.get(e.to)]
    if (!a || !b) continue
    if (e.kind === 'tunnel') {
      // Drawn from the gateway; the tunnel itself has no box.
      const gw = a.parentId ? model.nodes.get(a.parentId) : undefined
      out.push({ kind: 'tunnel', from: gw?.kind === 'vpngateway' ? gw : a, to: b, id: `tun:${a.id}`, label: a.name, ref: a.id })
    } else if (e.kind === 'manual') {
      out.push({ kind: 'manual', from: a, to: b, id: `ml:${e.ref ?? `${a.id}-${b.id}`}`, label: e.label ?? 'manual link', ref: a.id })
    }
  }
  return out
}

// --- contract view -------------------------------------------------------------

const DC_PILLS: [NodeKind, string, string?][] = [
  ['server', 'server'],
  ['lan', 'LAN'],
  ['nlb', 'NLB', 'NLB'],
  ['alb', 'ALB', 'ALB'],
  ['natgateway', 'NAT', 'NAT'],
  ['nodepool', 'node pool'],
  ['postgres', 'PostgreSQL', 'PostgreSQL'],
  ['mariadb', 'MariaDB', 'MariaDB'],
  ['mongodb', 'MongoDB', 'MongoDB'],
  ['inmemorydb', 'In-Memory DB', 'In-Memory DB'],
  ['kafka', 'Kafka', 'Kafka'],
  ['nfs', 'NFS', 'NFS'],
  ['vpngateway', 'VPN gateway'],
]

/**
 * All datacenters, grouped by location, linked by their Cross Connects. A
 * Cross Connect between exactly two datacenters is a line; any other number
 * of peers gets a hub node so the picture stays readable. Locations that
 * lines join are laid out together (`linkedLayout`), so those lines are
 * routed around the cards too. Of the layers only `links` applies here:
 * tunnels, manual links and the endpoints outside.
 */
export function contractDiagram(model: Model, options: Pick<DiagramOptions, 'hidden'> = {}): Diagram {
  const withLinks = !options.hidden?.has('links')
  const nodes: DiagramNode[] = []
  const edges: DiagramEdge[] = []
  const anchors = new Map<string, string>()

  const counts = new Map<string, Map<NodeKind, number>>()
  const publicDcs = new Set<string>()
  const appliances = new Map<string, number>()
  for (const n of model.nodes.values()) {
    if (!n.dcId || n.dcId === n.id) continue
    const c = counts.get(n.dcId) ?? new Map<NodeKind, number>()
    c.set(n.kind, (c.get(n.kind) ?? 0) + 1)
    counts.set(n.dcId, c)
    if (n.kind === 'lan' && n.subtype === 'public') publicDcs.add(n.dcId)
    if (n.appliance) appliances.set(n.dcId, (appliances.get(n.dcId) ?? 0) + 1)
  }

  const dcs = nodesOf(model, 'datacenter').sort(byName)
  const groupOf = new Map<string, string>()
  const locations = new Map<string, GraphNode[]>()
  for (const dc of dcs) {
    const loc = dc.location ?? 'unknown location'
    locations.set(loc, [...(locations.get(loc) ?? []), dc])
  }
  for (const [loc, list] of [...locations].sort((a, b) => a[0].localeCompare(b[0]))) {
    const gid = `loc:${loc}`
    nodes.push({
      id: gid,
      type: 'group',
      data: { title: loc, subtitle: plural(list.length, 'datacenter') },
      layout: { ...LAYERED, 'elk.padding': GROUP_PADDING, 'elk.aspectRatio': '2.4' },
    })
    for (const dc of list) {
      const c = counts.get(dc.id) ?? new Map()
      nodes.push({
        id: dc.id,
        type: 'dc',
        parent: gid,
        ref: dc.id,
        ...SIZE.dc,
        data: {
          ...base(dc),
          subtitle: fact(dc, 'Description') ?? dc.location,
          public: publicDcs.has(dc.id) || undefined,
          pills: [
            ...DC_PILLS.filter(([k]) => c.get(k)).map(([k, one, many]) => plural(c.get(k)!, one, many)),
            ...(appliances.get(dc.id) ? [plural(appliances.get(dc.id)!, 'appliance')] : []),
          ],
        },
      })
      groupOf.set(dc.id, gid)
      anchors.set(dc.id, dc.id)
    }
  }

  // Everything inside a datacenter is found on its card.
  for (const n of model.nodes.values()) {
    if (n.dcId && n.dcId !== n.id && anchors.has(n.dcId)) anchors.set(n.id, n.dcId)
  }

  for (const pcc of nodesOf(model, 'pcc').sort(byName)) {
    const peers = [...pccPeers(model, pcc.id).keys()].filter((id) => groupOf.has(id))
    peers.sort((a, b) => byName(model.nodes.get(a)!, model.nodes.get(b)!))
    const id = `cc:${pcc.id}`
    anchors.set(pcc.id, id)
    if (peers.length === 2) {
      edges.push({ id, source: peers[0], target: peers[1], kind: 'cross-connect', label: pcc.name, ref: pcc.id })
      continue
    }
    const groups = new Set(peers.map((p) => groupOf.get(p)!))
    let parent: string | undefined
    const unused = pcc.subtype === 'unused'
    if (peers.length === 0) {
      parent = unused ? 'group:unused-pcc' : 'group:invisible-pcc'
      if (!nodes.some((n) => n.id === parent)) {
        nodes.push({
          id: parent,
          type: 'group',
          data: { title: unused ? 'Unused Cross Connects' : 'Peers not in this snapshot' },
          layout: { ...PACKED, 'elk.padding': GROUP_PADDING, 'elk.spacing.nodeNode': '16' },
        })
      }
    } else if (groups.size === 1) parent = [...groups][0]
    nodes.push({
      id,
      type: 'hub',
      parent,
      ref: pcc.id,
      ...SIZE.hub,
      data: { ...base(pcc), subtitle: pccSubtitle(pcc, peers.length) },
    })
    for (const dc of peers) edges.push({ id: `${id}:${dc}`, source: dc, target: id, kind: 'cross-connect', ref: pcc.id })
  }

  // Everything outside the contract: VPN remote hosts and sites.
  const externals = withLinks ? nodesOf(model, 'external').sort(byName) : []
  if (externals.length) {
    const gid = 'group:external'
    nodes.push({
      id: gid,
      type: 'group',
      data: { title: 'Outside the contract', subtitle: plural(externals.length, 'endpoint') },
      layout: { ...PACKED, 'elk.padding': GROUP_PADDING, 'elk.spacing.nodeNode': '16' },
    })
    for (const n of externals) {
      nodes.push(externalNode(n, n.id, gid))
      anchors.set(n.id, n.id)
    }
  }

  // VPN tunnels and manual links between datacenters (or to the outside),
  // one line per pair and kind.
  const end = (n: GraphNode) => (n.kind === 'external' ? n.id : n.kind === 'datacenter' ? n.id : n.dcId)
  const pairs = new Map<string, { kind: 'tunnel' | 'manual'; a: string; b: string; items: { label?: string; ref: string; id: string }[] }>()
  for (const l of withLinks ? links(model) : []) {
    const [a, b] = [end(l.from), end(l.to)]
    if (!a || !b || a === b || !anchors.has(a) || !anchors.has(b)) continue
    const [x, y] = [a, b].sort()
    const key = `${l.kind}:${x}|${y}`
    const p = pairs.get(key) ?? { kind: l.kind, a: x, b: y, items: [] }
    p.items.push({ label: l.label, ref: l.ref, id: l.ref })
    pairs.set(key, p)
  }
  for (const [key, p] of pairs) {
    const one = p.items.length === 1 ? p.items[0] : undefined
    edges.push({
      id: key,
      source: p.a,
      target: p.b,
      kind: p.kind,
      label: one?.label ?? plural(p.items.length, p.kind === 'tunnel' ? 'VPN tunnel' : 'link'),
      ref: one?.ref,
    })
    if (p.kind === 'tunnel') for (const i of p.items) anchors.set(i.id, one ? key : (anchors.get(i.id) ?? key))
  }

  return {
    key: 'contract',
    nodes,
    edges,
    anchors,
    rootLayout: {
      'elk.algorithm': 'rectpacking',
      'elk.spacing.nodeNode': '40',
      'elk.aspectRatio': '1.8',
      'elk.padding': '[top=20,left=20,bottom=20,right=20]',
    },
    linkedLayout: LINKED,
  }
}

// --- datacenter view -----------------------------------------------------------

interface Device {
  node: GraphNode
  /** Attached LANs of this datacenter, most "upstream" first after ranking. */
  lans: { id: string; label?: string }[]
  /** Load balancers: the listener LAN goes first. */
  ordered?: boolean
}

/**
 * A server in this many LANs is drawn as a router: one line to its first LAN
 * at rest, the rest while it (or such a LAN) is selected. Real routers and
 * firewall VMs sit in 7, 8 or 16 LANs, and a line per LAN crosses the whole
 * view. The same number that marks a server as a likely network appliance.
 */
export const ROUTER_LANS = MANY_LANS

/** A group with more members than this is drawn collapsed: `GROUP_PREVIEW` of them and a "+N more" box. */
export const GROUP_LIMIT = 8
export const GROUP_PREVIEW = 6

/** What a datacenter view shows beyond its state at rest. Part of the layout: new boxes. */
export interface DiagramOptions {
  /** Boxes opened by the user: large groups shown in full, routers with their folded LANs. */
  expanded?: ReadonlySet<string>
  /** The selected model node; inside a collapsed group its server is shown anyway. */
  selected?: string
  /**
   * Layers the user switched off (`layers.ts`). Their boxes and lines are
   * left out; tiers and folded LANs are worked out with them, so the rest
   * of the picture keeps its shape.
   */
  hidden?: ReadonlySet<Layer>
  /**
   * Resources a view is about (focus and path views): always shown like the
   * selection, and a LAN among them is never folded into its router.
   */
  pinned?: ReadonlySet<string>
}

/**
 * Which members of a group are drawn. A group of more than `GROUP_LIMIT`
 * shows the first `GROUP_PREVIEW` by name and a "+N more" box, unless it is
 * expanded. Members that matter (`pinned`) are always shown and take room
 * from the preview, so selecting one keeps the group's size. A "more" box
 * never stands for a single member: that member is drawn instead.
 */
export function preview<T>(members: T[], open: boolean, pinned: (m: T) => boolean): { shown: T[]; hidden: T[] } {
  if (open || members.length <= GROUP_LIMIT) return { shown: members, hidden: [] }
  const keep = new Set(members.filter(pinned))
  let room = GROUP_PREVIEW - keep.size
  for (const m of members) if (room > 0 && !keep.has(m) && keep.add(m)) room--
  const hidden = members.filter((m) => !keep.has(m))
  return hidden.length < 2 ? { shown: members, hidden: [] } : { shown: members.filter((m) => keep.has(m)), hidden }
}

/** The "+N more" box at the end of a collapsed group. */
function moreNode(gid: string, hidden: number, of: number, what: string): DiagramNode {
  return {
    id: `more:${gid}`,
    type: 'more',
    parent: gid,
    ...SIZE.member,
    data: { title: `+${hidden} more`, subtitle: `Show all ${plural(of, what)}`, more: hidden },
  }
}

/** Trailing index stripped: `web-03` → `web`. Servers sharing a stem and LANs are grouped. */
export function stem(name: string) {
  return name.replace(/[-_. ]?\d+$/, '') || name
}

/**
 * Which LAN lines of routers are drawn only on demand, by router box. A
 * router always keeps the line to its first LAN (the one nearest the
 * internet), and the line to any LAN that nothing else would connect at
 * rest, so no LAN floats on its own. Routers are taken in order, so of two
 * routers sharing such a LAN the first draws it. LANs folded into a router
 * (`foldedLans`) are left out before.
 */
function routerLines(routers: Device[], others: Device[], boxOf: Map<string, string>): Map<string, Set<string>> {
  const connected = new Set(others.flatMap((d) => d.lans.map((l) => l.id)))
  for (const r of routers) if (r.lans[0]) connected.add(r.lans[0].id)
  const out = new Map<string, Set<string>>()
  for (const r of routers) {
    const box = boxOf.get(r.node.id)!
    if (out.has(box)) continue // the other members of a router group
    const later = new Set<string>()
    for (const l of r.lans.slice(1)) {
      if (connected.has(l.id)) later.add(l.id)
      else connected.add(l.id)
    }
    out.set(box, later)
  }
  return out
}

/**
 * LANs that fold into a router box, by LAN: not public, and the router box
 * is the only thing on them (real routers sit in many such LANs). Without a
 * Cross Connect the LAN is a stub, shown only as "+N LANs only here" on the
 * router; with one it is a transit LAN, drawn as the router's line straight
 * to the Cross Connect. A LAN between two routers connects them and stays.
 */
function foldedLans(lans: GraphNode[], devices: Device[], boxOf: (d: Device) => string, isRouter: (d: Device) => boolean) {
  const on = new Map<string, Set<string>>() // LAN → boxes on it
  for (const d of devices) for (const l of d.lans) on.set(l.id, (on.get(l.id) ?? new Set()).add(boxOf(d)))
  const routers = new Set(devices.filter(isRouter).map(boxOf))
  const out = new Map<string, string>()
  for (const lan of lans) {
    const boxes = [...(on.get(lan.id) ?? [])]
    if (lan.subtype !== 'public' && boxes.length === 1 && routers.has(boxes[0])) out.set(lan.id, boxes[0])
  }
  return out
}

/**
 * One datacenter as a network diagram: the internet on top, then LANs and the
 * resources between them, tiered by distance from the internet; Cross
 * Connects lead to the peer datacenters at the edge of the picture.
 */
export function datacenterDiagram(model: Model, dcId: string, options: DiagramOptions = {}): Diagram {
  const expanded = options.expanded ?? new Set<string>()
  const hide = options.hidden ?? NO_LAYERS
  const dc = model.nodes.get(dcId)
  const nodes: DiagramNode[] = []
  const edges: DiagramEdge[] = []
  const anchors = new Map<string, string>()
  const edgeIds = new Set<string>()
  const addEdge = (e: Omit<DiagramEdge, 'id'> & { id?: string }) => {
    const id = e.id ?? `${e.source}->${e.target}`
    if (edgeIds.has(id) || e.source === e.target) return
    edgeIds.add(id)
    edges.push({ ...e, id })
  }
  const hidden = new Map<string, string>()
  const empty: Diagram = {
    key: `dc:${dcId}`,
    nodes,
    edges,
    anchors,
    hidden,
    rootLayout: { ...LAYERED, 'elk.padding': '[top=20,left=20,bottom=20,right=20]', 'elk.aspectRatio': '1.6' },
  }
  if (!dc || dc.kind !== 'datacenter') return empty

  const kids = (model.children.get(dcId) ?? []).map((id) => model.nodes.get(id)!).sort(byName)
  const lans = kids.filter((k) => k.kind === 'lan')
  const lanIds = new Set(lans.map((l) => l.id))
  const out = (n: GraphNode) => (model.edgesByNode.get(n.id) ?? []).filter((e) => e.from === n.id)

  // Resources and the LANs they sit on.
  const devices: Device[] = []
  const attach = (node: GraphNode, kinds: string[]) => {
    const seen = new Set<string>()
    const list = out(node)
      .filter((e) => kinds.includes(e.kind) && lanIds.has(e.to) && !seen.has(e.to) && seen.add(e.to))
      .map((e) => ({ id: e.to, label: e.label }))
    devices.push({ node, lans: list, ordered: node.kind === 'nlb' || node.kind === 'alb' })
  }
  for (const k of kids) {
    if (k.kind === 'server') attach(k, ['member'])
    else if (k.kind === 'natgateway') attach(k, ['gateway'])
    else if (k.kind === 'nlb' || k.kind === 'alb') attach(k, ['listener', 'target-lan'])
  }
  for (const n of [...model.nodes.values()].sort(byName)) {
    if (n.kind === 'nodepool' && n.dcId === dcId) attach(n, ['member'])
    else if ((LAN_SERVICES.has(n.kind) || n.kind === 'vpngateway') && out(n).some((e) => e.kind === 'connection' && lanIds.has(e.to)))
      attach(n, ['connection'])
  }

  // Tier LANs by distance from the internet (public LANs first). NAT and VPN
  // gateways do not bridge tiers: they only give private LANs a way out.
  const edgeDevice = (n: GraphNode) => n.kind === 'natgateway' || n.kind === 'vpngateway'
  const level = new Map<string, number>()
  const neighbours = new Map<string, Set<string>>()
  for (const d of devices) {
    if (edgeDevice(d.node)) continue
    for (const a of d.lans) for (const b of d.lans) if (a.id !== b.id) neighbours.set(a.id, (neighbours.get(a.id) ?? new Set()).add(b.id))
  }
  const degree = (id: string) => devices.filter((d) => d.lans.some((l) => l.id === id)).length
  const bfs = (seeds: string[]) => {
    const queue = seeds.filter((s) => !level.has(s))
    queue.forEach((s) => level.set(s, 0))
    while (queue.length) {
      const cur = queue.shift()!
      for (const nb of [...(neighbours.get(cur) ?? [])].sort()) {
        if (level.has(nb)) continue
        level.set(nb, level.get(cur)! + 1)
        queue.push(nb)
      }
    }
  }
  bfs(lans.filter((l) => l.subtype === 'public').map((l) => l.id))
  for (const l of [...lans].sort((a, b) => degree(b.id) - degree(a.id))) if (!level.has(l.id)) bfs([l.id])
  const rank = (id: string) => level.get(id) ?? 0
  for (const d of devices) if (!d.ordered) d.lans.sort((a, b) => rank(a.id) - rank(b.id) || degree(b.id) - degree(a.id))

  // Resources in a hidden layer still shape the tiers above; from here on they are left out.
  const off = (d: Device) => hiddenKind(hide, d.node.kind)
  const shownDevices = devices.filter((d) => !off(d))

  // Internet.
  const hasInternet = lans.some((l) => l.subtype === 'public') || shownDevices.some((d) => edgeDevice(d.node) && d.node.ips.length)
  if (hasInternet) nodes.push({ id: 'internet', type: 'internet', ...SIZE.internet, data: { title: 'Internet' } })

  // Servers with the same name stem and LANs collapse into one group box.
  const groupKey = (d: Device) =>
    `${stem(d.node.name)}|${d.lans
      .map((l) => l.id)
      .sort()
      .join(',')}`
  const groups = new Map<string, Device[]>()
  for (const d of devices) if (d.node.kind === 'server') groups.set(groupKey(d), [...(groups.get(groupKey(d)) ?? []), d])
  const boxId = (d: Device) => (d.node.kind === 'server' && groups.get(groupKey(d))!.length > 1 ? `grp:${groupKey(d)}` : d.node.id)
  const isRouter = (d: Device) => d.node.kind === 'server' && d.lans.length >= ROUTER_LANS

  // LANs only a router uses fold into it; the rest are drawn.
  const pccEdges = new Map<string, string[]>() // pcc → LANs of this DC
  for (const lan of lans) {
    for (const e of model.edgesByNode.get(lan.id) ?? []) {
      if (e.kind === 'cross-connect' && e.from === lan.id) pccEdges.set(e.to, [...(pccEdges.get(e.to) ?? []), lan.id])
    }
  }
  const transit = new Set([...pccEdges.values()].flat())
  // A router the user unfolded (`lans:<box>` expanded) shows its LANs as boxes again.
  const foldable = foldedLans(
    lans.filter((l) => !options.pinned?.has(l.id)),
    devices,
    boxId,
    isRouter,
  )
  const folded = new Map([...foldable].filter(([, box]) => !expanded.has(`lans:${box}`)))
  const stubs = new Map<string, string[]>() // router box → names of LANs only it uses
  for (const lan of lans) {
    const box = foldable.get(lan.id)
    if (!box || transit.has(lan.id)) continue
    stubs.set(box, [...(stubs.get(box) ?? []), lan.name])
    if (folded.has(lan.id)) anchors.set(lan.id, box)
  }
  const only = (box: string) =>
    stubs.has(box) ? { lans: stubs.get(box)!, key: `lans:${box}`, open: expanded.has(`lans:${box}`) || undefined } : undefined
  const shown = (d: Device) => d.lans.filter((l) => !folded.has(l.id))

  // LANs; wider when busy so they read like a bus.
  for (const lan of lans) {
    if (folded.has(lan.id)) continue
    const links =
      shownDevices.filter((d) => d.lans.some((l) => l.id === lan.id)).length +
      [...pccEdges.values()].filter((l) => l.includes(lan.id)).length +
      (lan.subtype === 'public' ? 1 : 0)
    nodes.push({
      id: lan.id,
      type: 'lan',
      ref: lan.id,
      width: Math.min(960, Math.max(240, links * 72)),
      height: SIZE.lanHeight,
      data: {
        ...base(lan),
        subtitle: [lan.subtype === 'public' ? 'Public LAN' : 'Private LAN', fact(lan, 'LAN ID') && `ID ${fact(lan, 'LAN ID')}`]
          .filter(Boolean)
          .join(' · '),
        public: lan.subtype === 'public' || undefined,
      },
    })
    anchors.set(lan.id, lan.id)
    if (lan.subtype === 'public' && hasInternet) addEdge({ source: 'internet', target: lan.id, kind: 'internet' })
  }

  // What a collapsed group always shows: the selection (a NIC or volume: its
  // server), network appliances, and what is new or changed in a comparison.
  const selected = options.selected ? model.nodes.get(options.selected) : undefined
  const focus =
    selected?.kind === 'nic'
      ? selected.parentId
      : selected?.kind === 'volume'
        ? ((model.edgesByNode.get(selected.id) ?? []).find((e) => e.kind === 'attached' && e.to === selected.id)?.from ?? selected.id)
        : selected?.id
  const pinned = (n: GraphNode) => n.id === focus || !!options.pinned?.has(n.id) || !!n.appliance || !!n.change
  const hiddenIn = new Map<string, string>() // hidden member → its "more" box
  /** The members of a group as drawn, and its "more" box; hidden members are found on that box. */
  const collapse = (gid: string, list: GraphNode[], what: string) => {
    const open = expanded.has(gid)
    const { shown, hidden } = preview(list, open, pinned)
    for (const n of hidden) hiddenIn.set(n.id, `more:${gid}`)
    return {
      shown: new Set(shown),
      more: hidden.length ? moreNode(gid, hidden.length, list.length, what) : undefined,
      collapsible: (open && preview(list, false, pinned).hidden.length > 0) || undefined,
    }
  }

  const boxOf = new Map<string, string>() // device → node carrying its LAN edges
  for (const [key, members] of groups) {
    if (members.length < 2) continue
    const gid = `grp:${key}`
    const servers = members.map((m) => m.node)
    const { shown, more, collapsible } = collapse(gid, servers, 'server')
    const types = new Set(members.map((m) => subtypeLabel('server', m.node.subtype)))
    nodes.push({
      id: gid,
      type: 'group',
      layout: PACKED,
      data: {
        title: stem(members[0].node.name),
        subtitle: [plural(members.length, 'server'), types.size === 1 ? [...types][0] : undefined].filter(Boolean).join(' · '),
        kind: 'server',
        // Members share their LANs, so a group of routers is one router (an HA pair).
        lans: isRouter(members[0]) ? members[0].lans.length : undefined,
        only: only(gid),
        collapsible,
      },
    })
    for (const m of members.filter((x) => shown.has(x.node))) {
      nodes.push({
        id: m.node.id,
        type: 'member',
        parent: gid,
        ref: m.node.id,
        ...SIZE.member,
        data: { ...base(m.node), subtitle: ipLabel(m.node) ?? subtitle(m.node) },
      })
    }
    if (more) nodes.push(more)
    for (const m of members) boxOf.set(m.node.id, gid)
  }

  for (const d of shownDevices) {
    const n = d.node
    if (boxOf.has(n.id)) continue
    if (isRouter(d)) {
      nodes.push({
        id: n.id,
        type: 'router',
        ref: n.id,
        ...SIZE.router,
        data: { ...base(n), subtitle: subtitle(n), lans: d.lans.length, only: only(n.id) },
      })
    } else {
      nodes.push({ id: n.id, type: 'resource', ref: n.id, ...SIZE.resource, data: { ...base(n), subtitle: subtitle(n) } })
    }
    boxOf.set(n.id, n.id)
  }

  // A LAN only a hidden resource connects gets its router's line at rest.
  const others = shownDevices.filter((d) => !isRouter(d))
  const routers = devices.filter(isRouter).map((d) => ({ ...d, lans: shown(d) }))
  const onDemand = routerLines(routers, others, boxOf)
  const via = new Map<string, Set<string>>() // LAN → routers that reach it only on demand
  for (const d of shownDevices) {
    const n = d.node
    const box = boxOf.get(n.id)!
    const grouped = box !== n.id
    const [first, ...rest] = shown(d)
    if (edgeDevice(n)) {
      if (hasInternet && n.ips.length)
        addEdge({ source: 'internet', target: box, kind: 'internet', label: fact(n, 'Public IPs') ?? fact(n, 'Public IP') })
      d.lans.forEach((l) => addEdge({ source: box, target: l.id, kind: 'lan', label: l.label }))
      continue
    }
    if (first) addEdge({ source: first.id, target: box, kind: 'lan', label: grouped ? undefined : first.label })
    for (const l of rest) {
      const later = onDemand.get(box)?.has(l.id)
      addEdge({ source: box, target: l.id, kind: 'lan', label: grouped ? undefined : l.label, onDemand: later || undefined })
      if (later) via.set(l.id, (via.get(l.id) ?? new Set()).add(box))
    }
  }
  for (const [lan, boxes] of via) {
    const titles = [...boxes].map((r) => nodes.find((x) => x.id === r)!.data.title)
    nodes.find((x) => x.id === lan)!.data.via = titles.length === 1 ? titles[0] : plural(titles.length, 'router')
  }

  // Load balancer targets: drawn only while the balancer or a target is selected.
  for (const d of shownDevices) {
    if (d.node.kind !== 'nlb' && d.node.kind !== 'alb') continue
    const targets = out(d.node).filter((e) => e.kind === 'target')
    for (const fw of out(d.node).filter((e) => e.kind === 'forwards-to')) {
      targets.push(...(model.edgesByNode.get(fw.to) ?? []).filter((e) => e.kind === 'target' && e.from === fw.to))
    }
    for (const t of targets) {
      if (!boxOf.has(t.to)) continue
      // Targets in a collapsed group: one line to its "more" box.
      const to = hiddenIn.get(t.to) ?? t.to
      const label = to === t.to ? t.label : undefined
      addEdge({ id: `target:${d.node.id}->${to}`, source: d.node.id, target: to, kind: 'target', label, onDemand: true })
    }
  }

  /** Another datacenter, drawn as a node that opens its diagram. */
  const peerNode = (peer: GraphNode) => {
    const pid = `peer:${peer.id}`
    if (!nodes.some((n) => n.id === pid)) {
      nodes.push({ id: pid, type: 'peer', ref: peer.id, ...SIZE.peer, data: { ...base(peer), subtitle: peer.location } })
      anchors.set(peer.id, pid)
    }
    return pid
  }

  // Cross Connects and the datacenters behind them.
  const pccs = [...pccEdges.keys()].map((id) => model.nodes.get(id)!).sort(byName)
  for (const pcc of pccs) {
    const hub = `cc:${pcc.id}`
    const peers = pccPeers(model, pcc.id)
    peers.delete(dcId)
    nodes.push({
      id: hub,
      type: 'hub',
      ref: pcc.id,
      ...SIZE.hub,
      data: {
        ...base(pcc),
        subtitle: peers.size
          ? `to ${plural(peers.size, 'datacenter')}`
          : pcc.subtype === 'one LAN'
            ? 'only this LAN connected'
            : 'no other datacenter',
      },
    })
    anchors.set(pcc.id, hub)
    for (const lan of pccEdges.get(pcc.id)!) {
      const router = folded.get(lan)
      if (!router) {
        addEdge({ source: lan, target: hub, kind: 'cross-connect' })
        continue
      }
      // A transit LAN: the router's line goes straight to the Cross Connect, named after the LAN.
      const id = `${lan}->${hub}`
      addEdge({ id, source: router, target: hub, kind: 'cross-connect', label: model.nodes.get(lan)!.name, ref: lan })
      if (!anchors.has(lan)) anchors.set(lan, id)
    }
    const peerDcs = [...peers.keys()]
      .map((id) => model.nodes.get(id))
      .filter((n): n is GraphNode => !!n)
      .sort(byName)
    for (const peer of hide.has('peers') ? [] : peerDcs) {
      const pid = peerNode(peer)
      addEdge({
        source: hub,
        target: pid,
        kind: 'peer',
        label: peers
          .get(peer.id)!
          .map((l) => l.name)
          .join(', '),
      })
    }
  }

  // Leftovers that sit on no LAN, so nothing in the datacenter goes missing.
  const attachedVolumes = new Set(
    model.edges.filter((e) => e.kind === 'attached' && model.nodes.get(e.from)?.kind === 'server').map((e) => e.to),
  )
  const leftovers: [string, GraphNode[]][] = [
    ['Unattached volumes', kids.filter((k) => k.kind === 'volume' && !attachedVolumes.has(k.id))],
    ['Security Groups', kids.filter((k) => k.kind === 'securitygroup')],
    ['Other resources', kids.filter((k) => k.kind === 'other' || k.kind === 'autoscaling')],
  ]
  for (const [title, list] of leftovers) {
    if (!list.length || hide.has('leftovers')) continue
    const gid = `grp:${title}`
    const { shown, more, collapsible } = collapse(gid, list, 'resource')
    nodes.push({ id: gid, type: 'group', layout: PACKED, data: { title, subtitle: plural(list.length, 'resource'), collapsible } })
    for (const n of list.filter((x) => shown.has(x))) {
      nodes.push({ id: n.id, type: 'member', parent: gid, ref: n.id, ...SIZE.member, data: { ...base(n), subtitle: subtitle(n) } })
    }
    if (more) nodes.push(more)
    for (const n of list) boxOf.set(n.id, n.id)
  }

  // Map every resource of the datacenter to the box that shows it; a member
  // hidden in a collapsed group to its "more" box.
  for (const id of boxOf.keys()) anchors.set(id, hiddenIn.get(id) ?? id)
  const serverOf = new Map<string, string>()
  for (const e of model.edges) if (e.kind === 'attached' && boxOf.has(e.from)) serverOf.set(e.to, e.from)
  for (const n of model.nodes.values()) {
    if (anchors.has(n.id) || n.dcId !== dcId) continue
    const host = n.kind === 'nic' || n.kind === 'vpntunnel' ? n.parentId : serverOf.get(n.id)
    if (host && anchors.has(host)) anchors.set(n.id, anchors.get(host)!)
  }
  // What a "more" box stands for, by member, so search hits count members.
  for (const [id, a] of anchors) {
    const member = hiddenIn.has(id) ? id : [model.nodes.get(id)?.parentId, serverOf.get(id)].find((h) => h && hiddenIn.has(h))
    if (member && hiddenIn.get(member) === a) hidden.set(id, member)
  }
  for (const k8s of nodesOf(model, 'k8s')) {
    const pool = (model.children.get(k8s.id) ?? []).find((id) => anchors.has(id))
    if (pool) anchors.set(k8s.id, pool)
  }

  // VPN tunnels and manual links. The far end sits above the local one: a
  // peer datacenter node, or an endpoint outside the contract.
  // A folded LAN's line starts at its router (a transit LAN's anchor is a line).
  const local = (n: GraphNode) => (n.dcId === dcId && n.kind !== 'datacenter' ? (folded.get(n.id) ?? anchors.get(n.id)) : undefined)
  const remote = (n: GraphNode) => {
    if (n.kind === 'external') {
      const id = `x:${n.id}`
      if (!nodes.some((x) => x.id === id)) nodes.push(externalNode(n, id))
      anchors.set(n.id, id)
      return id
    }
    const other = model.nodes.get(n.kind === 'datacenter' ? n.id : (n.dcId ?? ''))
    return other?.kind === 'datacenter' && other.id !== dcId ? peerNode(other) : undefined
  }
  for (const l of hide.has('links') ? [] : links(model)) {
    const [a, b] = [local(l.from), local(l.to)]
    if (!a && !b) continue
    const [source, target] = a && b ? [a, b] : a ? [remote(l.to), a] : [remote(l.from), b]
    if (!source || !target) continue
    addEdge({ id: l.id, source, target, kind: l.kind, label: l.label, ref: l.ref })
    if (l.kind === 'tunnel') anchors.set(l.ref, l.id)
  }

  return empty
}

// --- focus and path views --------------------------------------------------------

/** A focus view: the datacenter view's options, and how far to look (see `neighbourhood`). */
export interface FocusOptions extends DiagramOptions {
  hops?: number
}

/**
 * The model cut down to these network nodes, their datacenters, the NICs
 * and VPN tunnels inside them and the volumes of their servers (so those
 * find their box), and the edges among all of them.
 */
function subModel(model: Model, keep: Iterable<string>): Model {
  const nodes = new Map<string, GraphNode>()
  const put = (id?: string) => {
    const n = id ? model.nodes.get(id) : undefined
    if (n) nodes.set(n.id, n)
  }
  for (const id of keep) {
    put(id)
    put(model.nodes.get(id)?.dcId)
    for (const c of model.children.get(id) ?? []) if (['nic', 'vpntunnel'].includes(model.nodes.get(c)?.kind ?? '')) put(c)
    for (const e of model.edgesByNode.get(id) ?? []) if (e.kind === 'attached' && e.from === id) put(e.to)
  }
  const edges = model.edges.filter((e) => nodes.has(e.from) && nodes.has(e.to))
  const children = new Map<string, string[]>()
  for (const n of nodes.values())
    if (n.parentId && nodes.has(n.parentId)) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n.id])
  const edgesByNode = new Map<string, GraphEdge[]>()
  for (const e of edges) for (const id of [e.from, e.to]) edgesByNode.set(id, [...(edgesByNode.get(id) ?? []), e])
  return { ...model, nodes, edges, children, edgesByNode }
}

/** The datacenter a resource is drawn in, if any. */
function dcOf(model: Model, id: string) {
  const dc = model.nodes.get(id)?.dcId
  return dc && model.nodes.get(dc)?.kind === 'datacenter' ? dc : undefined
}

/**
 * Everything within `hops` of one or more resources (the focus view; with
 * two, the "no route" view of a path), across datacenters. Each datacenter
 * is a group drawn by the datacenter view's rules (tiers, routers, folded
 * LANs, collapsed groups, layers), from the part of the model in reach;
 * the focus's datacenter comes first. Cross Connects sit between the groups
 * and lead to peer datacenters out of reach; endpoints outside the contract
 * and the tunnels and manual links in reach are drawn between them too. The
 * resources the view is about are marked `focus` and always shown.
 */
export function focusDiagram(model: Model, centres: string[], options: FocusOptions = {}): Diagram {
  const hops = options.hops ?? DEFAULT_HOPS
  const hide = options.hidden ?? NO_LAYERS
  const roots = [...new Set(centres.map((c) => networkNode(model, c)).filter((id): id is string => !!id))]
  const near = new Set<string>()
  for (const r of roots) for (const id of neighbourhood(model, r, hops).keys()) near.add(id)
  const sub = subModel(model, near)

  const nodes: DiagramNode[] = []
  const lines: DiagramEdge[] = []
  const anchors = new Map<string, string>()
  const hidden = new Map<string, string>()
  const ids = new Set<string>()
  const push = (n: DiagramNode) => {
    // A VPN gateway on LANs of two datacenters is drawn in the first.
    if (ids.has(n.id)) return
    ids.add(n.id)
    nodes.push(n)
  }

  const named = (ids: Iterable<string>) => [...ids].map((id) => model.nodes.get(id)!).sort(byName)
  const firstDcs = roots.map((r) => dcOf(model, r)).filter((d): d is string => !!d)
  const dcs = [
    ...new Set([...firstDcs, ...named(new Set([...near].map((id) => dcOf(model, id)).filter((d): d is string => !!d))).map((d) => d.id)]),
  ]

  // Each datacenter by its own rules. Cross Connects, peers and links are drawn across them below.
  const own = new Set<Layer>([...hide, 'links', 'peers'])
  // A LAN with something out of reach on it is not "only here": it is not folded into its router.
  const graph = networkGraph(model)
  const pinned = new Set([
    ...roots,
    ...[...near].filter((id) => model.nodes.get(id)!.kind === 'lan' && graph.get(id)!.some((e) => !near.has(e.to))),
  ])
  for (const dc of dcs) {
    const n = model.nodes.get(dc)!
    const gid = `focus:${dc}`
    push({
      id: gid,
      type: 'group',
      data: { title: n.name, subtitle: n.location },
      layout: { ...LAYERED, 'elk.padding': GROUP_PADDING, 'elk.aspectRatio': '1.6' },
    })
    anchors.set(dc, gid)
    const d = datacenterDiagram(sub, dc, { expanded: options.expanded, selected: options.selected, hidden: own, pinned })
    // Every datacenter has its own internet box; Cross Connect hubs are shared.
    const rename = (id: string) => (id === 'internet' ? `internet:${dc}` : id)
    for (const x of d.nodes) if (x.type !== 'hub') push({ ...x, id: rename(x.id), parent: x.parent ?? gid })
    for (const e of d.edges) lines.push(e.source === 'internet' ? { ...e, id: `internet:${dc}->${e.target}`, source: rename(e.source) } : e)
    for (const [k, v] of d.anchors) if (!anchors.has(k)) anchors.set(k, v)
    for (const [k, v] of d.hidden ?? []) hidden.set(k, v)
  }

  // Cross Connects between the groups; datacenters out of reach behind them as peers.
  for (const pcc of named(near).filter((n) => n.kind === 'pcc')) {
    const hub = `cc:${pcc.id}`
    const peers = pccPeers(model, pcc.id)
    push({ id: hub, type: 'hub', ref: pcc.id, ...SIZE.hub, data: { ...base(pcc), subtitle: pccSubtitle(pcc, peers.size) } })
    anchors.set(pcc.id, hub)
    if (hide.has('peers')) continue
    for (const dc of named(peers.keys())) {
      const lans = peers.get(dc.id)!
      if (lans.some((l) => near.has(l.id))) continue
      const pid = `peer:${dc.id}`
      push({ id: pid, type: 'peer', ref: dc.id, ...SIZE.peer, data: { ...base(dc), subtitle: dc.location } })
      if (!anchors.has(dc.id)) anchors.set(dc.id, pid)
      lines.push({ id: `${hub}->${pid}`, source: hub, target: pid, kind: 'peer', label: lans.map((l) => l.name).join(', ') })
    }
  }

  // Anything in reach the datacenter rules did not draw (a VPN gateway whose
  // LANs are out of reach) gets a box of its own, unless its layer is off.
  for (const n of named(near)) {
    if (anchors.has(n.id) || hiddenKind(hide, n.kind) || n.kind === 'external') continue
    const dc = dcOf(model, n.id)
    push({
      id: n.id,
      type: 'resource',
      parent: dc && `focus:${dc}`,
      ref: n.id,
      ...SIZE.resource,
      data: { ...base(n), subtitle: subtitle(n) },
    })
    anchors.set(n.id, n.id)
  }

  // Endpoints outside the contract, VPN tunnels and manual links in reach.
  if (!hide.has('links')) {
    for (const n of named(near).filter((x) => x.kind === 'external')) {
      push(externalNode(n, n.id))
      anchors.set(n.id, n.id)
    }
    // A transit LAN folded into its router is anchored on a line: links start at the router.
    const end = (n: GraphNode) => {
      const a = n.kind === 'datacenter' ? undefined : anchors.get(n.id)
      return a && (ids.has(a) ? a : lines.find((e) => e.id === a)?.source)
    }
    for (const l of links(sub)) {
      const [source, target] = [end(l.from), end(l.to)]
      if (!source || !target || source === target) continue
      lines.push({ id: l.id, source, target, kind: l.kind, label: l.label, ref: l.ref })
      if (l.kind === 'tunnel') anchors.set(l.ref, l.id)
    }
  }

  for (const r of roots) {
    const i = nodes.findIndex((n) => n.id === anchors.get(r))
    if (i >= 0) nodes[i] = { ...nodes[i], data: { ...nodes[i].data, focus: true } }
  }
  // Top-level boxes from the focus outwards: its datacenter, the Cross Connects
  // and endpoints next to it, the datacenters behind them, the peers. Lines
  // between groups are laid out from the earlier box to the later one, so
  // the picture reads from the focus down.
  const parentOf = new Map(nodes.map((n) => [n.id, n.parent]))
  const top = (id: string): string => (parentOf.get(id) ? top(parentOf.get(id)!) : id)
  const rank = (id: string) => {
    const n = nodes.find((x) => x.id === id)!
    if (n.type === 'group') return firstDcs.some((dc) => id === `focus:${dc}`) ? 0 : 3
    return n.type === 'hub' ? 1 : n.type === 'peer' ? 4 : 2
  }
  const ranks = new Map(nodes.filter((n) => !n.parent).map((n) => [n.id, rank(n.id)]))
  const ordered = nodes.map((n, i) => ({ n, r: ranks.get(top(n.id))!, i })).sort((a, b) => a.r - b.r || a.i - b.i)
  const edgeIds = new Set<string>()
  const edges = lines.filter((e) => ids.has(e.source) && ids.has(e.target) && !edgeIds.has(e.id) && edgeIds.add(e.id))
  return {
    key: `focus:${roots.join(',')}:${hops}`,
    nodes: ordered.map((x) => x.n),
    edges,
    anchors,
    hidden,
    rootLayout: {
      'elk.algorithm': 'rectpacking',
      'elk.spacing.nodeNode': '40',
      'elk.aspectRatio': '1.8',
      'elk.padding': '[top=20,left=20,bottom=20,right=20]',
    },
    linkedLayout: LINKED,
  }
}

/** How a step of a path is drawn. */
const PATH_LINE: Partial<Record<NetEdge['kind'], DiagramEdge['kind']>> = {
  'cross-connect': 'cross-connect',
  target: 'target',
  tunnel: 'tunnel',
  manual: 'manual',
}

/**
 * Paths from one resource to another, left to right (or, with `down`, top
 * to bottom, for a canvas taller than wide): the start, each hop (LAN,
 * Cross Connect, router, …), the end. A resource on several paths is one
 * box, so the paths fan out and join again; the alternatives of a step
 * (the other firewall of a pair) stand beside it. Boxes are grouped by
 * datacenter; Cross Connects and endpoints outside the contract sit between
 * the groups. Layers do not apply: a path shows what it uses.
 */
export function pathDiagram(model: Model, paths: Path[], { down = false } = {}): Diagram {
  const graph = networkGraph(model)
  const direction = down ? 'DOWN' : 'RIGHT'
  const nodes: DiagramNode[] = []
  const edges: DiagramEdge[] = []
  const anchors = new Map<string, string>()
  /** The group of a datacenter, made when its first box comes. */
  const group = (dc: string) => {
    const gid = `path:${dc}`
    if (!anchors.has(dc)) {
      const n = model.nodes.get(dc)!
      const layout = { ...LAYERED, 'elk.direction': direction, 'elk.padding': GROUP_PADDING }
      nodes.push({ id: gid, type: 'group', data: { title: n.name, subtitle: n.location }, layout })
      anchors.set(dc, gid)
    }
    return gid
  }
  const box = (id: string) => {
    if (anchors.has(id)) return
    const n = model.nodes.get(id)!
    const dc = dcOf(model, id)
    const parent = dc && group(dc)
    anchors.set(id, id)
    for (const c of model.children.get(id) ?? []) if (model.nodes.get(c)?.kind === 'nic') anchors.set(c, id)
    if (n.kind === 'external') return nodes.push(externalNode(n, id))
    const [type, size, what] =
      n.kind === 'lan'
        ? (['lan', { width: 240, height: SIZE.lanHeight }, n.subtype === 'public' ? 'Public LAN' : 'Private LAN'] as const)
        : n.kind === 'pcc'
          ? (['hub', SIZE.hub, pccSubtitle(n, pccPeers(model, n.id).size)] as const)
          : (['resource', SIZE.resource, subtitle(n)] as const)
    nodes.push({
      id,
      type,
      parent,
      ref: id,
      ...size,
      data: { ...base(n), subtitle: what, public: (n.kind === 'lan' && n.subtype === 'public') || undefined },
    })
  }
  const pairs = new Set<string>()
  for (const p of paths) {
    const at = p.nodes.map((id, i) => [id, ...p.alternatives[i]])
    at.flat().forEach(box)
    for (let i = 0; i + 1 < at.length; i++) {
      for (const x of at[i]) {
        for (const y of at[i + 1]) {
          const e = graph.get(x)?.find((g) => g.to === y)
          if (!e || pairs.has(`${x}|${y}`)) continue
          pairs.add(`${x}|${y}`).add(`${y}|${x}`)
          const kind = PATH_LINE[e.kind] ?? 'lan'
          const id = e.kind === 'tunnel' ? `tun:${e.ref}` : `p:${x}->${y}`
          // A tunnel selects the tunnel; a manual link (an annotation, no model node) its first end.
          edges.push({
            id,
            source: x,
            target: y,
            kind,
            label: e.label,
            ref: e.kind === 'tunnel' ? e.ref : e.kind === 'manual' ? x : undefined,
          })
          if (e.kind === 'tunnel' && e.ref) anchors.set(e.ref, id)
        }
      }
    }
  }
  const ends = new Set(paths.flatMap((p) => [p.nodes[0], p.nodes[p.nodes.length - 1]]))
  for (const n of nodes) if (ends.has(n.id)) n.data = { ...n.data, focus: true }
  const [from, to] = paths.length ? [paths[0].nodes[0], paths[0].nodes[paths[0].nodes.length - 1]] : []
  return {
    key: `path:${from},${to}:${down ? 'down' : 'right'}`,
    nodes,
    edges,
    anchors,
    rootLayout: { ...LAYERED, 'elk.direction': direction, 'elk.padding': '[top=20,left=20,bottom=20,right=20]' },
    // The groups and the Cross Connects between them are one graph, so every line is routed.
    linkedLayout: { ...LINKED, 'elk.direction': direction },
    directed: true,
  }
}

/**
 * Which diagram should show a resource picked outside the canvas: its own
 * datacenter, the current view if it is shown there, or the contract view.
 */
export function diagramFor(model: Model, id: string, current?: string): string | undefined {
  const n = model.nodes.get(id)
  if (!n) return current
  const inCurrent = (lans: string[]) => !!current && lans.some((l) => model.nodes.get(l)?.dcId === current)
  switch (n.kind) {
    case 'datacenter':
      return current === n.id ? current : undefined
    case 'pcc': {
      const lans = (model.edgesByNode.get(n.id) ?? []).filter((e) => e.kind === 'cross-connect').map((e) => e.from)
      return inCurrent(lans) ? current : undefined
    }
    case 'k8s': {
      const pools = (model.children.get(n.id) ?? []).map((c) => model.nodes.get(c)?.dcId).filter((d): d is string => !!d)
      return current && pools.includes(current) ? current : (pools[0] ?? current)
    }
  }
  if (n.dcId && model.nodes.get(n.dcId)?.kind === 'datacenter') return n.dcId
  return current
}
