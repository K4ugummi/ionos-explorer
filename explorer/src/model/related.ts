import { KINDS } from './kinds'
import type { EdgeKind, GraphNode, Model } from './types'

/** Group titles per edge kind: [seen from the edge's source, seen from its target]. */
const TITLES: Record<EdgeKind, [string, string]> = {
  member: ['LANs', 'Members'],
  attached: ['Attached', 'Attached to'],
  'cross-connect': ['Cross Connect', 'Connected LANs'],
  listener: ['Listener LAN', 'Load balancers listening here'],
  'target-lan': ['Target LAN', 'Load balancers targeting this LAN'],
  target: ['Targets', 'Load balanced by'],
  'forwards-to': ['Target groups', 'Used by'],
  gateway: ['NAT for LANs', 'NAT gateways'],
  'uses-image': ['Image', 'Used by volumes'],
  consumer: ['IPs in use by', 'IP block'],
  connection: ['Connected LANs', 'Managed services'],
}

export interface RelatedItem {
  node: GraphNode
  /** Edge detail such as an IP or port. */
  label?: string
}

export interface RelatedGroup {
  title: string
  items: RelatedItem[]
}

export function related(model: Model, id: string): RelatedGroup[] {
  const self = model.nodes.get(id)
  if (!self) return []
  const groups = new Map<string, RelatedItem[]>()
  for (const e of model.edgesByNode.get(id) ?? []) {
    const outgoing = e.from === id
    const other = model.nodes.get(outgoing ? e.to : e.from)
    if (!other) continue
    // A LAN lists the servers on it ("Members"); repeating each NIC adds noise.
    if (!outgoing && e.kind === 'attached' && other.kind === 'nic') continue
    let title = TITLES[e.kind][outgoing ? 0 : 1]
    if (e.kind === 'attached') title = outgoing ? `Attached ${KINDS[other.kind].plural}` : 'Attached to'
    const list = groups.get(title) ?? []
    list.push({ node: other, label: e.label })
    groups.set(title, list)
  }
  return [...groups].map(([title, items]) => ({
    title,
    items: items.sort((a, b) => a.node.name.localeCompare(b.node.name, undefined, { numeric: true })),
  }))
}

/** Parent chain from the root to the node (inclusive). */
export function breadcrumb(model: Model, id: string): GraphNode[] {
  const out: GraphNode[] = []
  const seen = new Set<string>()
  for (let n = model.nodes.get(id); n && !seen.has(n.id); n = n.parentId ? model.nodes.get(n.parentId) : undefined) {
    seen.add(n.id)
    out.unshift(n)
  }
  return out
}
