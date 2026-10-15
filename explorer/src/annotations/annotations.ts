import { indexChildren, indexEdges, indexNode } from '../model/build'
import type { GraphEdge, GraphNode, Model } from '../model/types'

/*
 * Annotations are what the user knows and the API does not: links between
 * resources (e.g. an IPsec tunnel inside two Cisco VMs), external sites
 * (head office, another cloud) and the IPs VMs really use where they differ
 * from what IONOS has on record. They live next to the snapshot, never inside
 * it, and are shown distinct from what the API reports.
 */

export const FORMAT = 'ionos-explorer-annotations'

export interface Site {
  id: string
  name: string
  /** Public IPs or host names; VPN tunnels to these end at the site. */
  hosts: string[]
  note?: string
}

export interface ManualLink {
  id: string
  /** Model node ids: resources, `site:<id>` or `ext:<host>`. */
  from: string
  to: string
  label?: string
  note?: string
}

/** The addresses a NIC really uses, when they differ from the IONOS record. */
export interface IpFix {
  /** NIC id; stays the same across exports. */
  nic: string
  ips: string[]
  note?: string
}

export interface Annotations {
  sites: Site[]
  links: ManualLink[]
  ips: IpFix[]
}

export const EMPTY: Annotations = { sites: [], links: [], ips: [] }

export const isEmpty = (a: Annotations) => !a.sites.length && !a.links.length && !a.ips.length

export const siteNodeId = (site: Pick<Site, 'id'>) => `site:${site.id}`

export function newId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
}

// --- editing ---------------------------------------------------------------------

export function addLink(a: Annotations, link: Omit<ManualLink, 'id'>): Annotations {
  return { ...a, links: [...a.links, { ...link, id: newId() }] }
}

export function removeLink(a: Annotations, id: string): Annotations {
  return { ...a, links: a.links.filter((l) => l.id !== id) }
}

export function addSite(a: Annotations, site: Omit<Site, 'id'>): [Annotations, Site] {
  const s = { ...site, id: newId() }
  return [{ ...a, sites: [...a.sites, s] }, s]
}

/** Removes a site and the links to it. */
export function removeSite(a: Annotations, id: string): Annotations {
  const node = siteNodeId({ id })
  return { ...a, sites: a.sites.filter((s) => s.id !== id), links: a.links.filter((l) => l.from !== node && l.to !== node) }
}

/** Sets (or replaces) the correction for fix.nic. */
export function setIpFix(a: Annotations, fix: IpFix): Annotations {
  return { ...a, ips: [...a.ips.filter((f) => f.nic !== fix.nic), fix] }
}

export function removeIpFix(a: Annotations, nic: string): Annotations {
  return { ...a, ips: a.ips.filter((f) => f.nic !== nic) }
}

/** Entries of b replace entries of a with the same id (IP corrections: same NIC). */
export function merge(a: Annotations, b: Annotations): Annotations {
  const by = <T>(x: T[], y: T[], key: (e: T) => string) => [...new Map([...x, ...y].map((e) => [key(e), e])).values()]
  return {
    sites: by(a.sites, b.sites, (e) => e.id),
    links: by(a.links, b.links, (e) => e.id),
    ips: by(a.ips, b.ips, (e) => e.nic),
  }
}

/** "10.0.0.5" or "10.0.0.5/24" → "10.0.0.5"; undefined if it is not an IPv4 or IPv6 address. */
export function normalizeIP(s: string): string | undefined {
  const ip = s
    .trim()
    .replace(/\/\d{1,3}$/, '')
    .toLowerCase()
  const v4 = ip.split('.')
  if (v4.length === 4 && v4.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)) return v4.map(Number).join('.')
  return ip.includes(':') && /^[0-9a-f:.]+$/.test(ip) && ip.length <= 45 ? ip : undefined
}

// --- files -----------------------------------------------------------------------

export function serialize(a: Annotations, contract?: number): string {
  return JSON.stringify({ format: FORMAT, version: 1, contract, sites: a.sites, links: a.links, ips: a.ips }, null, 2) + '\n'
}

const ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/
const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)

/** Parses an annotations file; throws with a readable message. Unknown fields are dropped. */
export function parse(input: string | unknown): { annotations: Annotations; contract?: number } {
  let doc: unknown = input
  if (typeof input === 'string') {
    try {
      doc = JSON.parse(input)
    } catch {
      throw new Error('Not a JSON file.')
    }
  }
  const d = (doc ?? {}) as Record<string, unknown>
  if (d.format !== FORMAT) throw new Error('Not an IONOS Explorer annotations file.')
  if (d.version !== 1) throw new Error(`Unsupported annotations version ${String(d.version)}.`)
  const sites: Site[] = []
  for (const raw of Array.isArray(d.sites) ? d.sites : []) {
    const s = (raw ?? {}) as Record<string, unknown>
    const id = text(s.id, 200)
    const name = text(s.name, 200)
    if (!id || !ID.test(id) || !name) continue
    const hosts = (Array.isArray(s.hosts) ? s.hosts : []).flatMap((h) => text(h, 255) ?? []).slice(0, 50)
    sites.push({ id, name, hosts, note: text(s.note, 2000) })
  }
  const links: ManualLink[] = []
  for (const raw of Array.isArray(d.links) ? d.links : []) {
    const l = (raw ?? {}) as Record<string, unknown>
    const [id, from, to] = [text(l.id, 200), text(l.from, 300), text(l.to, 300)]
    if (!id || !from || !to || ![id, from, to].every((x) => ID.test(x)) || from === to) continue
    links.push({ id, from, to, label: text(l.label, 200), note: text(l.note, 2000) })
  }
  const ips = new Map<string, IpFix>()
  for (const raw of Array.isArray(d.ips) ? d.ips : []) {
    const f = (raw ?? {}) as Record<string, unknown>
    const nic = text(f.nic, 200)
    const list = [...new Set((Array.isArray(f.ips) ? f.ips : []).flatMap((x) => (typeof x === 'string' ? (normalizeIP(x) ?? []) : [])))]
    if (!nic || !ID.test(nic) || !list.length) continue
    ips.set(nic, { nic, ips: list.slice(0, 16), note: text(f.note, 2000) })
  }
  return { annotations: { sites, links, ips: [...ips.values()] }, contract: typeof d.contract === 'number' ? d.contract : undefined }
}

// --- applying to the model ---------------------------------------------------------

export interface Applied {
  model: Model
  /** Links whose ends are not in this snapshot (deleted, or not visible). */
  dangling: ManualLink[]
  /** IP corrections for NICs that are not in this snapshot. */
  staleIps: IpFix[]
}

/**
 * Adds sites as external nodes and links as `manual` edges. VPN tunnels to a
 * host a site lists end at the site instead of an anonymous external node.
 */
export function applyAnnotations(model: Model, a: Annotations): Applied {
  if (isEmpty(a)) return { model, dangling: [], staleIps: [] }
  const nodes = new Map(model.nodes)
  const siteOfHost = new Map<string, string>()
  for (const s of a.sites) {
    const id = siteNodeId(s)
    const node: GraphNode = {
      id,
      kind: 'external',
      subtype: 'Site',
      name: s.name,
      parentId: model.rootId,
      ips: s.hosts.filter((h) => /^[\d.:a-f]+$/i.test(h) && /\d/.test(h)),
      macs: [],
      labels: {},
      facts: [
        { label: 'What', value: 'A site you added (not from the IONOS API)' },
        ...(s.hosts.length ? [{ label: 'Hosts', value: s.hosts.join(', ') }] : []),
        ...(s.note ? [{ label: 'Note', value: s.note }] : []),
      ],
      terms: ['site', ...s.hosts, ...(s.note ? [s.note] : [])],
      searchText: '',
      raw: s,
    }
    indexNode(node)
    nodes.set(id, node)
    for (const h of s.hosts) siteOfHost.set(`ext:${h.toLowerCase()}`, id)
  }
  const resolve = (id: string) => (nodes.has(id) ? id : (siteOfHost.get(id.toLowerCase()) ?? id))

  let edges: GraphEdge[] = model.edges.map((e) => {
    const site = e.kind === 'tunnel' ? siteOfHost.get(e.to.toLowerCase()) : undefined
    return site ? { ...e, to: site } : e
  })
  const fixed = fixIPs(model, nodes, a.ips)
  edges = edges.map((e) => fixed.labels.get(e) ?? e)
  // External hosts a site took over disappear unless something else uses them.
  const used = new Set(edges.flatMap((e) => [e.from, e.to]))
  for (const ext of siteOfHost.keys()) {
    for (const [id] of nodes) if (id.toLowerCase() === ext && !used.has(id)) nodes.delete(id)
  }

  const dangling: ManualLink[] = []
  for (const l of a.links) {
    const [from, to] = [resolve(l.from), resolve(l.to)]
    if (nodes.has(from) && nodes.has(to) && from !== to) edges.push({ kind: 'manual', from, to, label: l.label, ref: l.id })
    else dangling.push(l)
  }

  return {
    model: { ...model, nodes, edges, children: indexChildren(nodes.values()), edgesByNode: indexEdges(edges) },
    dangling,
    staleIps: fixed.stale,
  }
}

/**
 * Corrected NICs (and their servers) get the real IPs in `ips`, which search,
 * details and diagram use, and keep the IONOS ones in `ionosIps`. Nodes are
 * copied, so the snapshot model stays as the API reported it.
 */
function fixIPs(model: Model, nodes: Map<string, GraphNode>, fixes: IpFix[]) {
  const stale: IpFix[] = []
  const labels = new Map<GraphEdge, GraphEdge>()
  for (const f of fixes) {
    const nic = nodes.get(f.nic)
    if (nic?.kind !== 'nic') {
      stale.push(f)
      continue
    }
    const before = nic.ionosIps ?? nic.ips
    const ionos = before.join(', ')
    const copy: GraphNode = {
      ...nic,
      ips: f.ips,
      ionosIps: before,
      facts: nic.facts.flatMap((x) =>
        x.label === 'IPs'
          ? [
              { label: 'IPs', value: `${f.ips.join(', ')} (your correction)` },
              { label: 'IPs in IONOS', value: ionos || 'none' },
              ...(f.note ? [{ label: 'Correction note', value: f.note }] : []),
            ]
          : [x],
      ),
      terms: [...nic.terms, ...before],
    }
    indexNode(copy)
    nodes.set(copy.id, copy)

    const server = nic.parentId ? nodes.get(nic.parentId) : undefined
    if (server?.kind === 'server') {
      const original = server.ionosIps ?? server.ips
      const s: GraphNode = {
        ...server,
        // In place, so the first IP stays the first NIC's.
        ips: before.length
          ? server.ips.flatMap((ip) => (ip === before[0] ? f.ips : before.includes(ip) ? [] : [ip]))
          : [...server.ips, ...f.ips],
        ionosIps: original,
        terms: [...server.terms, ...before],
      }
      indexNode(s)
      nodes.set(s.id, s)
      // The LAN membership edge is labelled with the NIC's IPs.
      const lan = (model.edgesByNode.get(nic.id) ?? []).find((e) => e.kind === 'attached' && e.from === nic.id)?.to
      for (const e of model.edgesByNode.get(server.id) ?? []) {
        if (e.kind === 'member' && e.from === server.id && e.to === lan && e.label === ionos)
          labels.set(e, { ...e, label: f.ips.join(', ') })
      }
    }
  }
  return { stale, labels }
}

// --- browser storage ---------------------------------------------------------------

/** Annotations are kept per contract in this browser; files move them elsewhere. */
export function storageKey(model: Model): string {
  const n = model.manifest.contract?.number
  return `ionos-explorer:annotations:${n ?? model.nodes.get(model.rootId)?.name ?? 'unknown'}`
}

export function loadStored(key: string): Annotations {
  try {
    const raw = localStorage.getItem(key)
    return raw ? parse(raw).annotations : EMPTY
  } catch {
    return EMPTY
  }
}

export function saveStored(key: string, a: Annotations, contract?: number) {
  try {
    if (isEmpty(a)) localStorage.removeItem(key)
    else localStorage.setItem(key, serialize(a, contract))
  } catch {
    // Private mode or storage disabled: annotations last for this session only.
  }
}
