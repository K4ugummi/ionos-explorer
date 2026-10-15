import { KINDS } from '../model/kinds'
import type { GraphEdge, GraphNode, Model } from '../model/types'

/*
 * Compares two snapshots of the same contract. Resources are matched by ID
 * (UUIDs, LANs by datacenter and LAN id), so a rename is a change, not a
 * removal plus an addition. What is compared is what the explorer shows:
 * name, state, IPs, labels, properties (facts) and outgoing connections.
 * Timestamps and derived counts are left out; they change all the time.
 */

export type ChangeType = 'added' | 'removed' | 'changed'

export interface FieldChange {
  field: string
  before?: string
  after?: string
}

export interface Change {
  id: string
  type: ChangeType
  /** From the newer snapshot; from the older one for removed resources. */
  node: GraphNode
  /** Name of the datacenter it is in, in whichever snapshot has it. */
  dcName?: string
  /** Name of the resource it belongs to (a NIC's server), for context. */
  parentName?: string
  fields: FieldChange[]
  /** "2026-10-01 09:12 UTC by someone", when the API recorded a modification in between. */
  modified?: string
}

export interface Diff {
  older: Model
  newer: Model
  changes: Change[]
  byId: Map<string, Change>
  counts: Record<ChangeType, number>
}

/** Facts that change without anything worth reporting. */
const IGNORED_FACTS = new Set(['Created', 'Modified', 'State', 'Version'])

export function compareModels(older: Model, newer: Model): Diff {
  const changes: Change[] = []
  const context = (m: Model, n: GraphNode) => {
    const parent = n.parentId ? m.nodes.get(n.parentId) : undefined
    return {
      dcName: n.dcId && n.dcId !== n.id ? m.nodes.get(n.dcId)?.name : undefined,
      parentName: parent && parent.kind !== 'datacenter' && parent.id !== m.rootId ? parent.name : undefined,
    }
  }

  for (const n of newer.nodes.values()) {
    if (!comparable(n)) continue
    const o = older.nodes.get(n.id)
    if (!o || !comparable(o)) {
      changes.push({ id: n.id, type: 'added', node: n, ...context(newer, n), fields: [] })
      continue
    }
    const fields = compareNode(older, o, newer, n)
    if (fields.length) {
      const mod = fact(n, 'Modified')
      changes.push({
        id: n.id,
        type: 'changed',
        node: n,
        ...context(newer, n),
        fields,
        modified: mod && mod !== fact(o, 'Modified') ? mod : undefined,
      })
    }
  }
  for (const o of older.nodes.values()) {
    if (comparable(o) && !newer.nodes.has(o.id)) changes.push({ id: o.id, type: 'removed', node: o, ...context(older, o), fields: [] })
  }

  changes.sort(
    (a, b) =>
      (a.dcName ?? '').localeCompare(b.dcName ?? '') ||
      KINDS[a.node.kind].order - KINDS[b.node.kind].order ||
      a.node.name.localeCompare(b.node.name, undefined, { numeric: true }),
  )
  const counts = { added: 0, removed: 0, changed: 0 }
  changes.forEach((c) => counts[c.type]++)
  return { older, newer, changes, byId: new Map(changes.map((c) => [c.id, c])), counts }
}

/** Placeholders and items without a stable id cannot be matched. */
function comparable(n: GraphNode) {
  return !n.placeholder && !n.id.includes('#') && n.kind !== 'contract'
}

function compareNode(older: Model, o: GraphNode, newer: Model, n: GraphNode): FieldChange[] {
  const out: FieldChange[] = []
  const add = (field: string, before?: string, after?: string) => {
    if ((before ?? '') !== (after ?? '')) out.push({ field, before: before || undefined, after: after || undefined })
  }
  add('Name', o.name, n.name)
  add('State', o.state, n.state)
  if (o.parentId !== n.parentId) add('In', older.nodes.get(o.parentId ?? '')?.name, newer.nodes.get(n.parentId ?? '')?.name)
  // IONOS IPs: corrections are not part of a snapshot.
  add('IPs', (o.ionosIps ?? o.ips).join(', '), (n.ionosIps ?? n.ips).join(', '))
  for (const key of new Set([...Object.keys(o.labels), ...Object.keys(n.labels)])) add(`Label ${key}`, o.labels[key], n.labels[key])

  const facts = (x: GraphNode) =>
    new Map(x.facts.filter((f) => !IGNORED_FACTS.has(f.label) && !derived(x, f.label) && f.label !== 'IPs').map((f) => [f.label, f.value]))
  const [fo, fn] = [facts(o), facts(n)]
  for (const label of new Set([...fo.keys(), ...fn.keys()])) add(label, fo.get(label), fn.get(label))

  const [eo, en] = [connections(older, o), connections(newer, n)]
  for (const [key, text] of eo) if (!en.has(key)) out.push({ field: 'Connection', before: text })
  for (const [key, text] of en) if (!eo.has(key)) out.push({ field: 'Connection', after: text })
  return out
}

/** Datacenters list counts of what they contain; the contents are compared themselves. */
function derived(n: GraphNode, label: string) {
  return n.kind === 'datacenter' && (label.endsWith(' servers') || Object.values(KINDS).some((k) => k.plural === label))
}

const EDGE_TEXT: Record<GraphEdge['kind'], string> = {
  member: 'member of',
  attached: 'attached to',
  'cross-connect': 'joined to',
  listener: 'listens on',
  'target-lan': 'targets',
  target: 'targets',
  'forwards-to': 'forwards to',
  gateway: 'NAT for',
  'uses-image': 'uses',
  consumer: 'IP used by',
  connection: 'connected to',
  tunnel: 'tunnel to',
  manual: 'manual link to',
  'secured-by': 'secured by',
}

/**
 * Outgoing edges only, so a new server does not also "change" its LANs.
 * Edge labels (mostly IPs) are left out: IP changes are reported as such.
 */
function connections(m: Model, n: GraphNode) {
  const out = new Map<string, string>()
  for (const e of m.edgesByNode.get(n.id) ?? []) {
    if (e.from !== n.id || e.kind === 'manual') continue
    const other = m.nodes.get(e.to)
    out.set(`${e.kind}|${e.to}`, `${EDGE_TEXT[e.kind]} ${other ? `${KINDS[other.kind].label} ${other.name}` : e.to}`)
  }
  return out
}

function fact(n: GraphNode, label: string) {
  return n.facts.find((f) => f.label === label)?.value
}

/** Marks added and changed resources, and change counts on datacenters, on copies of the nodes. */
export function markChanges(model: Model, diff: Diff | undefined): Model {
  if (!diff?.changes.length) return model
  const nodes = new Map(model.nodes)
  for (const c of diff.changes) {
    const n = c.type !== 'removed' ? nodes.get(c.id) : undefined
    if (n) nodes.set(n.id, { ...n, change: c.type as 'added' | 'changed' })
  }
  for (const [dc, counts] of countsByDc(diff)) {
    const n = nodes.get(dc)
    if (n?.kind === 'datacenter') nodes.set(dc, { ...n, changeCounts: counts })
  }
  return { ...model, nodes }
}

/** "+2 ~5 −1" */
export function countsText(c: Record<ChangeType, number>) {
  return [c.added && `+${c.added}`, c.changed && `~${c.changed}`, c.removed && `−${c.removed}`].filter(Boolean).join(' ')
}

/** Per datacenter: how many resources in it were added, removed or changed. */
export function countsByDc(diff: Diff): Map<string, Record<ChangeType, number>> {
  const out = new Map<string, Record<ChangeType, number>>()
  for (const c of diff.changes) {
    const dc = c.node.kind === 'datacenter' ? c.node.id : c.node.dcId
    if (!dc) continue
    const r = out.get(dc) ?? { added: 0, removed: 0, changed: 0 }
    r[c.type]++
    out.set(dc, r)
  }
  return out
}
