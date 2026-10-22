import { KINDS, KIND_ALIASES, SERVER_TYPE_ALIASES } from '../model/kinds'
import type { GraphNode, Model, NodeKind } from '../model/types'

/**
 * Query syntax (all parts AND-ed, case-insensitive):
 *
 *   fra-core            free text: name, ID, IPs, MACs, labels, descriptions, …
 *   "two words"         quoted phrase
 *   kind:server         resource kind (aliases: vm, dc, lan, cc, k8s, pg, vpn, …)
 *   is:appliance        servers that look like network appliances
 *   is:corrected        NICs (and their servers) with an IP correction you entered
 *   is:added, is:changed  when comparing with an older snapshot: new or changed since
 *   is:expiring         certificates expired or ending within 30 days of the snapshot (is:expired: only those ended)
 *   is:dangling         DNS records naming an IP or host that is not in the contract
 *   dhcp:off            NICs whose IP IONOS does not assign (the VM may use another), and their servers
 *   type:cube           server type (cube, dedicated/enterprise, vcpu, gpu) or other subtype
 *   dc:fra-prod         datacenter name (substring or glob)
 *   loc:de/fra          location (substring or glob)
 *   ip:10.7.*           IP (prefix or glob; also the IONOS IP of corrected NICs), mac:02:01:ab
 *   label:env=prod      label (key, or key=value, glob allowed)
 *   state:shutoff       VM state / resource state
 *   -term, -kind:nic    exclude
 */

export const FILTER_KEYS = ['kind', 'is', 'type', 'dc', 'loc', 'location', 'ip', 'mac', 'label', 'tag', 'state', 'id', 'dhcp'] as const
type FilterKey = (typeof FILTER_KEYS)[number]

export interface Term {
  key?: FilterKey
  value: string
  negate: boolean
}

export interface SearchResult {
  hits: Hit[]
  /** Hit counts per kind, ignoring kind filters, so the UI can offer them. */
  kindCounts: Map<NodeKind, number>
  terms: Term[]
}

export interface Hit {
  node: GraphNode
  score: number
}

export function parseQuery(q: string): Term[] {
  const terms: Term[] = []
  const re = /(-?)(?:(\w+):)?(?:"([^"]*)"|(\S+))/g
  for (const m of q.matchAll(re)) {
    const negate = m[1] === '-'
    const rawKey = m[2]?.toLowerCase()
    const value = (m[3] ?? m[4] ?? '').toLowerCase()
    if (rawKey && (FILTER_KEYS as readonly string[]).includes(rawKey)) {
      if (value) terms.push({ key: rawKey as FilterKey, value, negate })
    } else {
      // Unknown "key:" stays part of the free text (e.g. URNs, MACs).
      const text = (m[2] ? `${m[2]}:` : '') + (m[3] ?? m[4] ?? '')
      if (text) terms.push({ value: text.toLowerCase(), negate })
    }
  }
  return terms
}

export function search(model: Model, query: string, limit = Infinity): SearchResult {
  const terms = parseQuery(query)
  const kindCounts = new Map<NodeKind, number>()
  if (terms.length === 0) return { hits: [], kindCounts, terms }

  const kindTerms = terms.filter((t) => t.key === 'kind' || t.key === 'is')
  const otherTerms = terms.filter((t) => !kindTerms.includes(t))
  const hits: Hit[] = []

  for (const node of model.nodes.values()) {
    let score = 0
    let ok = true
    for (const t of otherTerms) {
      const s = matchTerm(model, node, t)
      if (t.negate ? s > 0 : s === 0) {
        ok = false
        break
      }
      if (!t.negate) score += s
    }
    if (!ok) continue
    kindCounts.set(node.kind, (kindCounts.get(node.kind) ?? 0) + 1)
    if (kindTerms.every((t) => matchKind(node, t.value) !== t.negate)) {
      // Filter-only queries still need an order: kind, then name.
      hits.push({ node, score: score || 1 })
    }
  }

  hits.sort(
    (a, b) =>
      b.score - a.score ||
      KINDS[a.node.kind].order - KINDS[b.node.kind].order ||
      a.node.name.localeCompare(b.node.name, undefined, { numeric: true }),
  )
  return { hits: hits.slice(0, limit), kindCounts, terms }
}

function matchKind(node: GraphNode, value: string) {
  if (value === 'appliance') return !!node.appliance
  if (value === 'corrected') return !!node.ionosIps
  if (value === 'added' || value === 'new') return node.change === 'added'
  if (value === 'changed' || value === 'modified') return node.change === 'changed'
  if (node.flags?.includes(value)) return true
  const kind = KIND_ALIASES[value] ?? value
  return node.kind === kind
}

/** Returns a positive score when the term matches, 0 otherwise. */
function matchTerm(model: Model, node: GraphNode, t: Term): number {
  const v = t.value
  switch (t.key) {
    case 'type': {
      const want = (SERVER_TYPE_ALIASES[v] ?? v).toLowerCase()
      return node.subtype && glob(want, node.subtype.toLowerCase()) ? 10 : 0
    }
    case 'dc': {
      const dc = node.dcId ? model.nodes.get(node.dcId) : undefined
      return dc && contains(v, dc.name.toLowerCase()) ? 10 : 0
    }
    case 'loc':
    case 'location':
      return node.location && contains(v, node.location.toLowerCase()) ? 10 : 0
    case 'ip':
      return bestOf(node.ionosIps ? [...node.ips, ...node.ionosIps] : node.ips, v, 90, 55)
    case 'dhcp': {
      const want = ['on', 'yes', 'true', '1'].includes(v) ? true : ['off', 'no', 'false', '0', 'static'].includes(v) ? false : undefined
      if (want === undefined) return 0
      const nics = node.kind === 'nic' ? [node] : node.kind === 'server' ? nicsOf(model, node) : []
      return nics.some((n) => n.dhcp === want) ? 10 : 0
    }
    case 'mac':
      return bestOf(node.macs, v, 90, 55)
    case 'state':
      return node.state && glob(v, node.state.toLowerCase()) ? 10 : 0
    case 'id':
      return glob(v, node.id.toLowerCase()) || node.id.toLowerCase().startsWith(v) ? 10 : 0
    case 'label':
    case 'tag': {
      const [k, val] = v.split('=', 2)
      return Object.entries(node.labels).some(([lk, lv]) => glob(k, lk.toLowerCase()) && (val === undefined || glob(val, lv.toLowerCase())))
        ? 10
        : 0
    }
    default:
      return freeText(node, v)
  }
}

function nicsOf(model: Model, server: GraphNode) {
  return (model.children.get(server.id) ?? []).map((id) => model.nodes.get(id)!).filter((n) => n.kind === 'nic')
}

function freeText(node: GraphNode, v: string): number {
  const name = node.name.toLowerCase()
  if (v.includes('*')) return glob(v, name) ? 60 : node.searchText.split('\n').some((s) => glob(v, s)) ? 15 : 0
  if (name === v) return 100
  const id = node.id.toLowerCase()
  if (id === v) return 95
  const ip = bestOf(node.ips, v, 90, 55)
  if (ip === 90) return ip
  if (name.startsWith(v)) return 70
  const mac = bestOf(node.macs, v, 85, 50)
  if (mac) return mac
  if (ip) return ip
  if (name.includes(v)) return 50
  if (v.length >= 6 && id.startsWith(v)) return 60
  return node.searchText.includes(v) ? 15 : 0
}

function bestOf(values: string[], v: string, exact: number, prefix: number): number {
  let best = 0
  for (const x of values) {
    const lx = x.toLowerCase()
    if (lx === v || (v.includes('*') && glob(v, lx))) return exact
    if (lx.startsWith(v)) best = prefix
  }
  return best
}

function contains(pattern: string, s: string) {
  return pattern.includes('*') ? glob(pattern, s) : s.includes(pattern)
}

const globCache = new Map<string, RegExp>()

/** Whole-string match with `*` wildcards; without `*` it is an exact match. */
function glob(pattern: string, s: string): boolean {
  let re = globCache.get(pattern)
  if (!re) {
    re = new RegExp('^' + pattern.split('*').map(escapeRe).join('.*') + '$')
    globCache.set(pattern, re)
  }
  return re.test(s)
}

function escapeRe(s: string) {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}
