import { subtypeLabel } from '../model/kinds'
import type { GraphNode, Model } from '../model/types'

/** One-line context for a node: subtype · datacenter (or location) · first IP. */
export function nodeContext(model: Model, node: GraphNode, opts: { skipDc?: string } = {}) {
  const dc = node.dcId && node.dcId !== node.id && node.dcId !== opts.skipDc ? model.nodes.get(node.dcId)?.name : undefined
  return [subtypeLabel(node.kind, node.subtype), dc ?? (node.dcId ? undefined : node.location), node.ips[0]]
    .filter(Boolean)
    .join(' · ')
}
