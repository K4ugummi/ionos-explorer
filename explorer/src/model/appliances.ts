import { entityItems, obj, props, str, type Obj } from './raw'
import type { Appliance, GraphNode, Model } from './types'

/*
 * Network appliances (virtual routers, firewalls, VPN endpoints) are plain
 * servers to the IONOS API, and links they build (IPsec, GRE, SD-WAN) are
 * invisible to it. This flags servers that look like appliances, always with
 * the reasons, so people know where to look and where to add manual links.
 *
 * The rules are data: add products to IMAGE_RULES and words to NAME_HINTS.
 */

export interface ImageRule {
  /** Matched against image and CD-ROM names, case-insensitive. */
  pattern: RegExp
  product: string
}

export const IMAGE_RULES: ImageRule[] = [
  { pattern: /c8000v|catalyst[-_ ]?8000/i, product: 'Cisco Catalyst 8000V' },
  { pattern: /csr[-_ ]?1000v?/i, product: 'Cisco CSR 1000V' },
  { pattern: /(^|[^a-z])asav/i, product: 'Cisco ASAv' },
  { pattern: /ftdv|firepower/i, product: 'Cisco Secure Firewall (FTDv)' },
  { pattern: /viptela|vedge|cedge/i, product: 'Cisco SD-WAN' },
  { pattern: /fortigate|fortios|fgt[-_]?vm/i, product: 'Fortinet FortiGate-VM' },
  { pattern: /pa[-_]?vm|pan[-_]?os/i, product: 'Palo Alto VM-Series' },
  { pattern: /check[-_ ]?point|cloudguard|gaia/i, product: 'Check Point CloudGuard' },
  { pattern: /vsrx|junos/i, product: 'Juniper vSRX' },
  { pattern: /sophos|xg[-_]?firewall/i, product: 'Sophos Firewall' },
  { pattern: /big[-_]?ip/i, product: 'F5 BIG-IP' },
  { pattern: /velocloud/i, product: 'VMware SD-WAN (VeloCloud)' },
  { pattern: /vyos/i, product: 'VyOS' },
  { pattern: /pfsense/i, product: 'pfSense' },
  { pattern: /opnsense/i, product: 'OPNsense' },
  { pattern: /routeros|mikrotik|(^|[^a-z])chr([^a-z]|$)/i, product: 'MikroTik Cloud Hosted Router' },
  { pattern: /openwrt/i, product: 'OpenWrt' },
]

/** Words in server names or label values that hint at a network role. */
export const NAME_HINTS = new Set([
  'fw',
  'firewall',
  'vpn',
  'router',
  'rtr',
  'gw',
  'gateway',
  'edge',
  'asa',
  'csr',
  'ngfw',
  'utm',
  'sdwan',
  'ipsec',
  'nva',
])

const IKE_PORTS = [500, 4500]

export function detectAppliances(model: Model) {
  for (const n of model.nodes.values()) {
    if (n.kind !== 'server') continue
    const a = detect(model, n)
    if (!a) continue
    n.appliance = a
    n.terms.push('appliance', 'network appliance', a.title)
  }
}

function detect(model: Model, server: GraphNode): Appliance | undefined {
  const edges = model.edgesByNode.get(server.id) ?? []
  const node = (id: string) => model.nodes.get(id)
  const reasons: string[] = []

  // 1. The image says what it is.
  const images: [string, string][] = []
  for (const e of edges) {
    const v = node(e.to)
    if (e.kind !== 'attached' || e.from !== server.id || v?.kind !== 'volume') continue
    const image = v.facts.find((f) => f.label === 'Image')?.value
    if (image) images.push([`Volume ${v.name} uses image`, image])
  }
  for (const c of entityItems(obj(server.raw), 'cdroms')) {
    const name = str(props(c).name)
    if (name) images.push(['CD-ROM', name])
  }
  let product: string | undefined
  for (const [what, image] of images) {
    const rule = IMAGE_RULES.find((r) => r.pattern.test(image))
    if (!rule) continue
    product ??= rule.product
    reasons.push(`${what} “${image}”, which looks like ${rule.product}.`)
  }

  // 2. A managed VPN gateway has a tunnel to it.
  const tunnels = edges.filter((e) => e.kind === 'tunnel' && e.to === server.id).map((e) => node(e.from)!)
  for (const t of tunnels) {
    const gw = t.parentId ? node(t.parentId) : undefined
    reasons.push(`VPN tunnel ${t.name}${gw ? ` of ${gw.name}` : ''} ends at this server’s public IP.`)
  }

  // 3. Its firewall or Security Groups let IPsec in.
  const nics = (model.children.get(server.id) ?? []).map(node).filter((c): c is GraphNode => c?.kind === 'nic')
  const allows = (rules: Obj[]) => new Set(rules.flatMap((r) => ipsecRule(props(r)) ?? []))
  const and = (x: Set<string>) => [...x].sort().join(' and ')
  const ipsec = allows(nics.flatMap((nic) => entityItems(obj(nic.raw), 'firewallrules')))
  if (ipsec.size) reasons.push(`Firewall rules allow ${and(ipsec)}.`)
  const groups = new Set(
    [server, ...nics].flatMap((n) =>
      (model.edgesByNode.get(n.id) ?? []).filter((e) => e.kind === 'secured-by' && e.from === n.id).map((e) => e.to),
    ),
  )
  for (const g of [...groups].map(node)) {
    const found = g ? allows(entityItems(obj(g.raw), 'rules')) : new Set<string>()
    if (!found.size) continue
    reasons.push(`Security Group ${g!.name} allows ${and(found)}.`)
    found.forEach((x) => ipsec.add(x))
  }

  // 4. It sits between networks.
  const lans = edges
    .filter((e) => e.kind === 'member' && e.from === server.id)
    .map((e) => node(e.to))
    .filter((l): l is GraphNode => l?.kind === 'lan')
  const pub = lans.filter((l) => l.subtype === 'public').map((l) => l.name)
  const priv = lans.filter((l) => l.subtype !== 'public').map((l) => l.name)
  const routing = (pub.length > 0 && priv.length > 0) || lans.length >= 3
  const lanList = (names: string[], kind: string) => `${kind} ${names.length === 1 ? 'LAN' : 'LANs'} ${names.join(', ')}`
  if (pub.length && priv.length) reasons.push(`NICs in the ${lanList(pub, 'public')} and the ${lanList(priv, 'private')}.`)
  else if (routing) reasons.push(`NICs in ${lans.length} LANs (${lans.map((l) => l.name).join(', ')}).`)

  // 5. It shares a failover IP, typical for HA firewall pairs.
  const failover = lans.flatMap((l) => l.ips.filter((ip) => server.ips.includes(ip)).map((ip) => `${ip} in ${l.name}`))
  if (failover.length) reasons.push(`Holds the failover IP ${failover.join(', ')}.`)

  // 6. Its name or labels say so.
  const words = [server.name, ...Object.values(server.labels)].flatMap((s) => s.toLowerCase().split(/[^a-z0-9]+/))
  const hints = [...new Set(words.filter((w) => NAME_HINTS.has(w)))]
  if (hints.length) reasons.push(`Name or labels contain ${hints.map((h) => `“${h}”`).join(', ')}.`)

  if (product) return { title: product, confidence: 'high', reasons }
  if (tunnels.length) return { title: 'VPN endpoint', confidence: 'high', reasons }
  if (ipsec.size && routing) return { title: 'Likely firewall or VPN gateway', confidence: 'medium', reasons }
  const weak = [ipsec.size > 0, failover.length > 0, hints.length > 0].filter(Boolean).length
  if (routing && weak >= 1 && (hints.length > 0 || weak >= 2)) return { title: 'Possible router or firewall', confidence: 'low', reasons }
  return undefined
}

/** "ESP", "AH" or "IKE (UDP 500/4500)" when a rule admits IPsec. */
function ipsecRule(r: Obj): string | undefined {
  const proto = str(r.protocol)?.toUpperCase()
  if (proto === 'ESP' || proto === 'AH') return proto
  if (proto !== 'UDP' && proto !== 'ANY') return undefined
  const start = Number(r.portRangeStart ?? 1)
  const end = Number(r.portRangeEnd ?? 65535)
  if (proto === 'ANY' && r.portRangeStart == null) return undefined // allow-all is not a hint
  return IKE_PORTS.some((p) => p >= start && p <= end) && end - start < 1000 ? 'IKE (UDP 500/4500)' : undefined
}
