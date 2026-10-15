import type { Model, NodeKind } from '../model/types'

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
  { id: 'managed', label: 'Managed services', title: 'Kubernetes node pools and PostgreSQL clusters' },
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
  managed: ['nodepool', 'postgres'],
}

/** Whether a resource of this kind is in a hidden layer. */
export const hiddenKind = (hidden: ReadonlySet<Layer>, kind: NodeKind) => [...hidden].some((l) => KINDS[l]?.includes(kind))

export const NO_LAYERS: Layers = { hidden: new Set() }

export const STORAGE_KEY = 'ionos-explorer:layers'

/** Reads a stored choice; anything unknown or broken counts as "everything shown". */
export function parseLayers(raw: string | null): Layers {
  if (!raw) return NO_LAYERS
  try {
    const v = JSON.parse(raw) as { hidden?: unknown; emphasis?: unknown }
    const known = new Set<string>(LAYERS.map((l) => l.id))
    const hidden = Array.isArray(v.hidden) ? v.hidden.filter((x): x is Layer => typeof x === 'string' && known.has(x)) : []
    const emphasis = v.emphasis === 'appliances' || v.emphasis === 'changes' ? v.emphasis : undefined
    return { hidden: new Set(hidden), emphasis }
  } catch {
    return NO_LAYERS
  }
}

export function serializeLayers(l: Layers): string {
  return JSON.stringify({ hidden: LAYERS.map((x) => x.id).filter((id) => l.hidden.has(id)), emphasis: l.emphasis })
}

export function loadLayers(): Layers {
  try {
    return parseLayers(localStorage.getItem(STORAGE_KEY))
  } catch {
    return NO_LAYERS
  }
}

export function saveLayers(l: Layers) {
  try {
    if (!l.hidden.size && !l.emphasis) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, serializeLayers(l))
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
