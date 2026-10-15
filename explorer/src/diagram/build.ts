import { countsText } from '../diff/diff'
import { KINDS, subtypeLabel } from '../model/kinds'
import type { GraphNode, Model, NodeKind } from '../model/types'
import type { Diagram, DiagramEdge, DiagramNode, NodeData } from './types'

// Fixed node sizes; the renderer uses the same numbers.
export const SIZE = {
  dc: { width: 260, height: 112 },
  hub: { width: 220, height: 52 },
  peer: { width: 220, height: 52 },
  resource: { width: 236, height: 54 },
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
      : n.kind === 'postgres'
        ? `PostgreSQL ${fact(n, 'PostgreSQL') ?? ''}`.trim()
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
  ['vpngateway', 'VPN gateway'],
]

/**
 * All datacenters, grouped by location, linked by their Cross Connects. A
 * Cross Connect between exactly two datacenters is a line; any other number
 * of peers gets a hub node so the picture stays readable.
 */
export function contractDiagram(model: Model): Diagram {
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
  const externals = nodesOf(model, 'external').sort(byName)
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
  for (const l of links(model)) {
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

/** Trailing index stripped: `web-03` → `web`. Servers sharing a stem and LANs are grouped. */
export function stem(name: string) {
  return name.replace(/[-_. ]?\d+$/, '') || name
}

/**
 * One datacenter as a network diagram: the internet on top, then LANs and the
 * resources between them, tiered by distance from the internet; Cross
 * Connects lead to the peer datacenters at the edge of the picture.
 */
export function datacenterDiagram(model: Model, dcId: string): Diagram {
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
  const empty: Diagram = {
    key: `dc:${dcId}`,
    nodes,
    edges,
    anchors,
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
    else if ((n.kind === 'postgres' || n.kind === 'vpngateway') && out(n).some((e) => e.kind === 'connection' && lanIds.has(e.to)))
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

  // Internet.
  const hasInternet = lans.some((l) => l.subtype === 'public') || devices.some((d) => edgeDevice(d.node) && d.node.ips.length)
  if (hasInternet) nodes.push({ id: 'internet', type: 'internet', ...SIZE.internet, data: { title: 'Internet' } })

  // LANs; wider when busy so they read like a bus.
  const pccEdges = new Map<string, string[]>() // pcc → LANs of this DC
  for (const lan of lans) {
    for (const e of model.edgesByNode.get(lan.id) ?? []) {
      if (e.kind === 'cross-connect' && e.from === lan.id) pccEdges.set(e.to, [...(pccEdges.get(e.to) ?? []), lan.id])
    }
  }
  for (const lan of lans) {
    const links = degree(lan.id) + [...pccEdges.values()].filter((l) => l.includes(lan.id)).length + (lan.subtype === 'public' ? 1 : 0)
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

  // Servers with the same name stem and LANs collapse into one group box.
  const groups = new Map<string, Device[]>()
  for (const d of devices) {
    if (d.node.kind !== 'server') continue
    const key = `${stem(d.node.name)}|${d.lans
      .map((l) => l.id)
      .sort()
      .join(',')}`
    groups.set(key, [...(groups.get(key) ?? []), d])
  }
  const boxOf = new Map<string, string>() // device → node carrying its LAN edges
  for (const [key, members] of groups) {
    if (members.length < 2) continue
    const gid = `grp:${key}`
    const types = new Set(members.map((m) => subtypeLabel('server', m.node.subtype)))
    nodes.push({
      id: gid,
      type: 'group',
      layout: PACKED,
      data: {
        title: stem(members[0].node.name),
        subtitle: [plural(members.length, 'server'), types.size === 1 ? [...types][0] : undefined].filter(Boolean).join(' · '),
        kind: 'server',
      },
    })
    for (const m of members) {
      nodes.push({
        id: m.node.id,
        type: 'member',
        parent: gid,
        ref: m.node.id,
        ...SIZE.member,
        data: { ...base(m.node), subtitle: ipLabel(m.node) ?? subtitle(m.node) },
      })
      boxOf.set(m.node.id, gid)
    }
  }

  for (const d of devices) {
    const n = d.node
    if (!boxOf.has(n.id)) {
      nodes.push({ id: n.id, type: 'resource', ref: n.id, ...SIZE.resource, data: { ...base(n), subtitle: subtitle(n) } })
      boxOf.set(n.id, n.id)
    }
    const box = boxOf.get(n.id)!
    const grouped = box !== n.id
    const [first, ...rest] = d.lans
    if (edgeDevice(n)) {
      if (hasInternet && n.ips.length)
        addEdge({ source: 'internet', target: box, kind: 'internet', label: fact(n, 'Public IPs') ?? fact(n, 'Public IP') })
      d.lans.forEach((l) => addEdge({ source: box, target: l.id, kind: 'lan', label: l.label }))
      continue
    }
    if (first) addEdge({ source: first.id, target: box, kind: 'lan', label: grouped ? undefined : first.label })
    rest.forEach((l) => addEdge({ source: box, target: l.id, kind: 'lan', label: grouped ? undefined : l.label }))
  }

  // Load balancer targets: drawn only while the balancer or a target is selected.
  for (const d of devices) {
    if (d.node.kind !== 'nlb' && d.node.kind !== 'alb') continue
    const targets = out(d.node).filter((e) => e.kind === 'target')
    for (const fw of out(d.node).filter((e) => e.kind === 'forwards-to')) {
      targets.push(...(model.edgesByNode.get(fw.to) ?? []).filter((e) => e.kind === 'target' && e.from === fw.to))
    }
    for (const t of targets) {
      if (!boxOf.has(t.to)) continue
      addEdge({ id: `target:${d.node.id}->${t.to}`, source: d.node.id, target: t.to, kind: 'target', label: t.label, onDemand: true })
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
    for (const lan of pccEdges.get(pcc.id)!) addEdge({ source: lan, target: hub, kind: 'cross-connect' })
    const peerDcs = [...peers.keys()]
      .map((id) => model.nodes.get(id))
      .filter((n): n is GraphNode => !!n)
      .sort(byName)
    for (const peer of peerDcs) {
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
    ['Other resources', kids.filter((k) => k.kind === 'other')],
  ]
  for (const [title, list] of leftovers) {
    if (!list.length) continue
    const gid = `grp:${title}`
    nodes.push({ id: gid, type: 'group', layout: PACKED, data: { title, subtitle: plural(list.length, 'resource') } })
    for (const n of list) {
      nodes.push({ id: n.id, type: 'member', parent: gid, ref: n.id, ...SIZE.member, data: { ...base(n), subtitle: subtitle(n) } })
      boxOf.set(n.id, n.id)
    }
  }

  // Map every resource of the datacenter to the box that shows it.
  for (const id of boxOf.keys()) anchors.set(id, id)
  const serverOf = new Map<string, string>()
  for (const e of model.edges) if (e.kind === 'attached' && boxOf.has(e.from)) serverOf.set(e.to, e.from)
  for (const n of model.nodes.values()) {
    if (anchors.has(n.id) || n.dcId !== dcId) continue
    const host = n.kind === 'nic' || n.kind === 'vpntunnel' ? n.parentId : serverOf.get(n.id)
    if (host && anchors.has(host)) anchors.set(n.id, anchors.get(host)!)
  }
  for (const k8s of nodesOf(model, 'k8s')) {
    const pool = (model.children.get(k8s.id) ?? []).find((id) => anchors.has(id))
    if (pool) anchors.set(k8s.id, pool)
  }

  // VPN tunnels and manual links. The far end sits above the local one: a
  // peer datacenter node, or an endpoint outside the contract.
  const local = (n: GraphNode) => (n.dcId === dcId && n.kind !== 'datacenter' ? anchors.get(n.id) : undefined)
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
  for (const l of links(model)) {
    const [a, b] = [local(l.from), local(l.to)]
    if (!a && !b) continue
    const [source, target] = a && b ? [a, b] : a ? [remote(l.to), a] : [remote(l.from), b]
    if (!source || !target) continue
    addEdge({ id: l.id, source, target, kind: l.kind, label: l.label, ref: l.ref })
    if (l.kind === 'tunnel') anchors.set(l.ref, l.id)
  }

  return empty
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
