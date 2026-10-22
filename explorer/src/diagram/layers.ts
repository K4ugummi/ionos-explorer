import type { Model, NodeKind } from '../model/types'
import type { Diagram } from './types'

/**
 * Kinds of things the user can take out of the diagram. A hidden layer is
 * left out when the diagram is built, so the layout uses the room; an
 * emphasis only dims the rest (`toFlow`) and never lays the view out again.
 */
export type Layer = 'lb' | 'gateways' | 'managed' | 'links' | 'leftovers' | 'peers'
export type Emphasis = 'appliances' | 'changes'

export interface Layers {
  hidden: ReadonlySet<Layer>
  emphasis?: Emphasis
}

export const LAYERS: { id: Layer; label: string; title: string; contract?: boolean }[] = [
  { id: 'lb', label: 'Load balancers', title: 'Network and application load balancers and their target lines' },
  { id: 'gateways', label: 'NAT and VPN gateways', title: 'NAT gateways, VPN gateways and the tunnels drawn from them' },
  { id: 'managed', label: 'Managed services', title: 'Kubernetes node pools, databases, Kafka and file storage' },
  { id: 'links', label: 'VPN tunnels and manual links', title: 'Also the endpoints outside the contract', contract: true },
  {
    id: 'leftovers',
    label: 'Security Groups, unattached volumes',
    title: 'The groups of things on no LAN: unattached volumes, Security Groups, other resources',
  },
  { id: 'peers', label: 'Cross Connect peers', title: 'The other datacenters behind a Cross Connect' },
]

/** Resource kinds each layer stands for; the other layers are not resources (lines, groups, peers). */
const KINDS: Partial<Record<Layer, NodeKind[]>> = {
  lb: ['nlb', 'alb'],
  gateways: ['natgateway', 'vpngateway'],
  managed: ['nodepool', 'postgres', 'mariadb', 'mongodb', 'inmemorydb', 'kafka', 'nfs'],
}

/** Whether a resource of this kind is in a hidden layer. */
export const hiddenKind = (hidden: ReadonlySet<Layer>, kind: NodeKind) => [...hidden].some((l) => KINDS[l]?.includes(kind))

export const NO_LAYERS: Layers = { hidden: new Set() }

/**
 * Where a choice is kept: per contract (`scope`, its number), so each
 * contract keeps its own; the key without a scope is the one choice of
 * earlier versions, still read for a contract that has none yet.
 */
export const STORAGE_KEY = 'ionos-explorer:layers'
const storageKey = (scope?: string) => (scope ? `${STORAGE_KEY}:${scope}` : STORAGE_KEY)

/** Reads a stored choice; anything unknown or broken counts as "everything shown". */
export function parseLayers(raw: string | null): Layers {
  if (!raw) return NO_LAYERS
  try {
    const v = JSON.parse(raw) as { hidden?: unknown; emphasis?: unknown }
    return fromParts(Array.isArray(v.hidden) ? v.hidden : [], v.emphasis)
  } catch {
    return NO_LAYERS
  }
}

function fromParts(hidden: unknown[], emphasis: unknown): Layers {
  const known = new Set<string>(LAYERS.map((l) => l.id))
  return {
    hidden: new Set(hidden.filter((x): x is Layer => typeof x === 'string' && known.has(x))),
    emphasis: emphasis === 'appliances' || emphasis === 'changes' ? emphasis : undefined,
  }
}

export function serializeLayers(l: Layers): string {
  return JSON.stringify({ hidden: LAYERS.map((x) => x.id).filter((id) => l.hidden.has(id)), emphasis: l.emphasis })
}

/**
 * The choice in a link: `hide=lb,managed` and `emphasis=appliances` in the
 * hash, so a shared link shows what its sender saw. Undefined when the
 * link says nothing about layers.
 */
export function layersFromHash(hide: string | null, emphasis: string | null): Layers | undefined {
  if (hide === null && emphasis === null) return undefined
  return fromParts((hide ?? '').split(','), emphasis)
}

/** Hash entries for a choice; everything shown removes them. */
export function layersHash(l: Layers): { hide?: string; emphasis?: string } {
  const hide = LAYERS.map((x) => x.id).filter((id) => l.hidden.has(id))
  return { hide: hide.length ? hide.join(',') : undefined, emphasis: l.emphasis }
}

export function loadLayers(scope?: string): Layers {
  try {
    const own = scope ? localStorage.getItem(storageKey(scope)) : null
    return parseLayers(own ?? localStorage.getItem(STORAGE_KEY))
  } catch {
    return NO_LAYERS
  }
}

export function saveLayers(l: Layers, scope?: string) {
  try {
    // Everything shown is stored too: it overrides the choice of earlier versions.
    if (!scope && !l.hidden.size && !l.emphasis) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(storageKey(scope), serializeLayers(l))
  } catch {
    // Private mode or storage disabled: the choice lasts as long as the page.
  }
}

/**
 * The model nodes an emphasis keeps bright, or null when nothing is
 * emphasised. "Only changes" needs a comparison; without one it is off.
 */
export function emphasized(model: Model, emphasis: Emphasis | undefined, comparing: boolean): Set<string> | null {
  if (emphasis === 'appliances') return new Set([...model.nodes.values()].filter((n) => n.appliance).map((n) => n.id))
  if (emphasis === 'changes' && comparing) return new Set([...model.nodes.values()].filter((n) => n.change).map((n) => n.id))
  return null
}

/** Whether a diagram has a box or line for a model node. */
const shows = (d: Diagram, id: string) => {
  const a = d.anchors.get(id)
  return !!a && (d.nodes.some((n) => n.id === a) || d.edges.some((e) => e.id === a))
}

/**
 * The hidden layers that keep a model node out of a view: the first one
 * that alone brings it back, else all of them if only showing everything
 * does (a tunnel needs both its gateway and the tunnel lines). Empty when
 * the node is shown, or would not be in this view anyway. `build` makes the
 * view's diagram with other layers hidden; `diagram` is the current one.
 */
export function hiddenBy(
  id: string,
  hidden: ReadonlySet<Layer>,
  diagram: Diagram,
  build: (hidden: ReadonlySet<Layer>) => Diagram,
): Layer[] {
  if (!hidden.size || shows(diagram, id)) return []
  const on = LAYERS.map((l) => l.id).filter((l) => hidden.has(l))
  const one = on.find((l) => shows(build(new Set(on.filter((x) => x !== l))), id))
  if (one) return [one]
  return on.length > 1 && shows(build(new Set()), id) ? on : []
}
