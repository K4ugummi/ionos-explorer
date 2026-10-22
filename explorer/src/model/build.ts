import type { Coverage, Snapshot } from '../snapshot/types'
import { detectAppliances } from './appliances'
import { KINDS, LAN_SERVICES, subtypeLabel } from './kinds'
import { arr, entityItems, isObj, items, num, obj, props, str, strs, type Obj } from './raw'
import type { CoverageIssue, EdgeKind, Fact, GraphEdge, GraphNode, Model } from './types'

/**
 * Turns a snapshot's raw API documents into a graph. Documents are routed by
 * the coverage entry's endpoint template (not by file path), and anything
 * without a handler still becomes searchable as an `other` node.
 */
export function buildModel(snapshot: Snapshot): Model {
  return new Builder(snapshot).build()
}

interface Doc {
  cov: Coverage
  params: Record<string, string>
  doc: unknown
}

type NodeInit = Partial<GraphNode> & Pick<GraphNode, 'id' | 'kind' | 'name'>

const ROOT_ID = 'contract'

class Builder {
  private nodes = new Map<string, GraphNode>()
  private edges: GraphEdge[] = []
  private edgeKeys = new Set<string>()
  private warnings: string[] = []
  private docs = new Map<string, Doc[]>()
  private templates = new Map<string, string>()
  private images = new Map<string, string>()
  /** lan node id → private IP → NIC id, for resolving load balancer targets. */
  private lanIPs = new Map<string, Map<string, string>>()
  /** public IP → node id (NICs on public LANs, NAT gateways, load balancers). */
  private publicIPs = new Map<string, string>()
  /** LAN → Cross Connect references, resolved after /pccs is processed. */
  private pendingPCC: { lan: string; pcc: string }[] = []
  /** Host names services answer at (registries, databases, CDN domains) → node id, for DNS names pointing at them. */
  private hosts = new Map<string, string>()
  /** DNS address records (A, AAAA, CNAME, ALIAS) by name, and what records point at, linked once every resource is known. */
  private fqdns = new Map<string, string[]>()
  private dnsLinks: { id: string; type: string; target: string }[] = []
  /** Zone names, to tell a record pointing into the contract's own zones from one pointing elsewhere. */
  private zoneNames: string[] = []
  /** CDN distributions' certificates and origins, linked after the certificates and DNS records. */
  private cdnLinks: { id: string; cert?: string; origins: string[] }[] = []
  /** Every IP → the resource that has it, built when first needed (after all resources with IPs). */
  private ipIndex?: Map<string, string>
  private snapshot: Snapshot

  constructor(snapshot: Snapshot) {
    this.snapshot = snapshot
    for (const cov of snapshot.manifest.coverage) {
      if (cov.status !== 'ok' || !cov.file) continue
      const doc = snapshot.files.get(cov.file)
      if (doc === undefined) {
        this.warnings.push(`Coverage lists ${cov.file}, but the file is missing.`)
        continue
      }
      const key = `${apiFamily(cov.api)} ${cov.endpoint}`
      const list = this.docs.get(key) ?? []
      list.push({ cov, params: matchEndpoint(cov.endpoint, cov.path) ?? {}, doc })
      this.docs.set(key, list)
    }
  }

  build(): Model {
    this.contract()
    this.catalogs()
    this.each('cloudapi /datacenters', (d) => items(d.doc).forEach((dc) => this.datacenter(dc)))
    this.each('cloudapi /datacenters/{datacenterId}/lans', (d) => this.lans(d))
    this.each('cloudapi /datacenters/{datacenterId}/volumes', (d) => items(d.doc).forEach((v) => this.volume(v, d.params.datacenterId)))
    this.each('cloudapi /datacenters/{datacenterId}/securitygroups', (d) =>
      items(d.doc).forEach((g) => this.securityGroup(g, d.params.datacenterId)),
    )
    this.each('cloudapi /datacenters/{datacenterId}/servers', (d) => items(d.doc).forEach((s) => this.server(s, d.params.datacenterId)))
    this.each('cloudapi /datacenters/{datacenterId}/natgateways', (d) =>
      items(d.doc).forEach((n) => this.natGateway(n, d.params.datacenterId)),
    )
    const albTargetLANs = new Map<string, string>()
    this.each('cloudapi /datacenters/{datacenterId}/networkloadbalancers', (d) =>
      items(d.doc).forEach((lb) => this.loadBalancer(lb, d.params.datacenterId, 'nlb', albTargetLANs)),
    )
    this.each('cloudapi /datacenters/{datacenterId}/applicationloadbalancers', (d) =>
      items(d.doc).forEach((lb) => this.loadBalancer(lb, d.params.datacenterId, 'alb', albTargetLANs)),
    )
    this.each('cloudapi /targetgroups', (d) => items(d.doc).forEach((tg) => this.targetGroup(tg, albTargetLANs)))
    this.each('cloudapi /pccs', (d) => items(d.doc).forEach((p) => this.pcc(p)))
    this.linkLANsToPCCs()
    // VPN gateways before IP blocks (their public IPs are consumers) and after
    // everything a tunnel can end at.
    this.each('vpn /ipsecgateways', (d) => items(d.doc).forEach((g) => this.vpnGateway(g, 'IPsec', d.cov.api)))
    this.each('vpn /wireguardgateways', (d) => items(d.doc).forEach((g) => this.vpnGateway(g, 'WireGuard', d.cov.api)))
    this.each('vpn /ipsecgateways/{gatewayId}/tunnels', (d) => items(d.doc).forEach((t) => this.vpnTunnel(t, d.params.gatewayId, 'IPsec')))
    this.each('vpn /wireguardgateways/{gatewayId}/peers', (d) =>
      items(d.doc).forEach((t) => this.vpnTunnel(t, d.params.gatewayId, 'WireGuard')),
    )
    this.each('cloudapi /ipblocks', (d) => items(d.doc).forEach((b) => this.ipBlock(b)))
    this.each('cloudapi /k8s', (d) => items(d.doc).forEach((c) => this.k8s(c)))
    this.each('cloudapi /k8s/{k8sClusterId}/nodepools', (d) => items(d.doc).forEach((np) => this.nodePool(np, d.params.k8sClusterId)))
    this.each('postgresql /clusters', (d) => items(d.doc).forEach((c) => this.postgres(c, d.cov.api)))
    this.each('mariadb /clusters', (d) => items(d.doc).forEach((c) => this.database(c, d.cov.api, 'mariadb')))
    this.each('inmemorydb /clusters', (d) => items(d.doc).forEach((c) => this.database(c, d.cov.api, 'inmemorydb')))
    this.each('mongodb /clusters', (d) => items(d.doc).forEach((c) => this.database(c, d.cov.api, 'mongodb')))
    this.each('kafka /clusters', (d) => items(d.doc).forEach((c) => this.kafka(c, d.cov.api)))
    this.each('kafka /clusters/{clusterId}/topics', (d) => this.kafkaTopics(d.params.clusterId, items(d.doc)))
    this.each('nfs /clusters', (d) => items(d.doc).forEach((c) => this.nfs(c, d.cov.api)))
    this.each('nfs /clusters/{clusterId}/shares', (d) => items(d.doc).forEach((x) => this.nfsShare(x, d.params.clusterId)))
    this.each('autoscaling /groups', (d) => items(d.doc).forEach((g) => this.autoscaling(g)))
    this.each('autoscaling /groups/{groupId}/servers', (d) => this.autoscalingServers(d.params.groupId, items(d.doc)))
    this.each('cloudapi /backupunits', (d) => items(d.doc).forEach((b) => this.backupUnit(b)))
    this.each('cloudapi /snapshots', (d) => items(d.doc).forEach((x) => this.volumeSnapshot(x)))
    this.each('containerregistry /registries', (d) => items(d.doc).forEach((r) => this.registry(r)))
    this.each('containerregistry /registries/{registryId}/repositories', (d) => this.repositories(d.params.registryId, items(d.doc)))
    this.each('logging /pipelines', (d) => items(d.doc).forEach((x) => this.pipeline(x, d.cov.api, 'Logging')))
    this.each('monitoring /pipelines', (d) => items(d.doc).forEach((x) => this.pipeline(x, d.cov.api, 'Monitoring')))
    this.each('certmanager /certificates', (d) => items(d.doc).forEach((c) => this.certificate(c)))
    this.each('certmanager /auto-certificates', (d) => items(d.doc).forEach((c) => this.autoCertificate(c)))
    // The CDN before DNS records (its IPs are what they point at), its links after them.
    this.each('cdn /distributions', (d) => items(d.doc).forEach((x) => this.cdn(x)))
    this.each('dns /zones', (d) => items(d.doc).forEach((z) => this.zone(z, false)))
    this.each('dns /secondaryzones', (d) => items(d.doc).forEach((z) => this.zone(z, true)))
    this.each('dns /records', (d) => items(d.doc).forEach((r) => this.record(r)))
    this.each('dns /reverserecords', (d) => items(d.doc).forEach((r) => this.reverseRecord(r)))
    this.linkDNS()
    this.linkCertificatesAndOrigins()
    this.each('cloudapi /labels', (d) => items(d.doc).forEach((l) => this.label(l)))
    for (const list of this.docs.values()) list.forEach((d) => this.generic(d))
    return this.finish()
  }

  // --- routing -----------------------------------------------------------------

  /** Runs fn for each document of an endpoint and marks them handled. */
  private each(key: string, fn: (d: Doc) => void) {
    const list = this.docs.get(key)
    if (!list) return
    this.docs.delete(key)
    list.forEach(fn)
  }

  // --- node helpers ------------------------------------------------------------

  private add(init: NodeInit): GraphNode {
    const existing = this.nodes.get(init.id)
    if (existing && !existing.placeholder) return existing
    const node: GraphNode = {
      ips: [],
      macs: [],
      labels: {},
      facts: [],
      terms: [],
      searchText: '',
      raw: undefined,
      ...init,
      // A real resource replaces a placeholder but keeps edges pointing at it.
      placeholder: init.placeholder ?? false,
    }
    if (existing) node.labels = { ...existing.labels, ...node.labels }
    this.nodes.set(node.id, node)
    return node
  }

  private edge(kind: EdgeKind, from: string | undefined, to: string | undefined, label?: string) {
    if (!from || !to || from === to) return
    const key = `${kind}|${from}|${to}|${label ?? ''}`
    if (this.edgeKeys.has(key)) return
    this.edgeKeys.add(key)
    this.edges.push({ kind, from, to, label })
  }

  private dcNode(dcId: string | undefined) {
    return dcId ? this.nodes.get(dcId) : undefined
  }

  private lanId(dcId: string, lanId: unknown) {
    return `${dcId}:lan:${str(lanId)}`
  }

  private lanName(dcId: string, lanId: unknown) {
    return this.nodes.get(this.lanId(dcId, lanId))?.name ?? `LAN ${str(lanId)}`
  }

  // --- resources ---------------------------------------------------------------

  private contract() {
    let contract: Obj | undefined
    this.each('cloudapi /contracts', (d) => (contract ??= items(d.doc)[0]))
    const p = contract ? props(contract) : {}
    const number = str(p.contractNumber) ?? str(this.snapshot.manifest.contract?.number)
    const limits = obj(p.resourceLimits)
    const facts = [
      fact('Owner', str(p.owner) ?? this.snapshot.manifest.contract?.owner),
      fact('Status', str(p.status)),
      fact('Registration domain', str(p.regDomain)),
      fact('Cores provisioned', ratio(limits.coresProvisioned, limits.coresPerContract)),
      fact('RAM provisioned', ratio(gb(limits.ramProvisioned), gb(limits.ramPerContract))),
      fact('Reserved IPs', ratio(limits.reservedIpsOnContract, limits.reservableIps)),
    ]
    this.add({ id: ROOT_ID, kind: 'contract', name: number ? `Contract ${number}` : 'Contract', facts: compact(facts), raw: contract })
  }

  private catalogs() {
    this.each('cloudapi /templates', (d) =>
      items(d.doc).forEach((t) => {
        const id = str(t.id)
        if (id) this.templates.set(id, str(props(t).name) ?? id)
      }),
    )
    this.each('cloudapi /images', (d) =>
      items(d.doc).forEach((img) => {
        const id = str(img.id)
        const p = props(img)
        if (!id) return
        this.images.set(id, str(p.name) ?? id)
        // Public images are a catalog; only uploaded images are resources of this contract.
        if (p.public === true) return
        this.add({
          id,
          kind: 'image',
          subtype: str(p.imageType),
          name: str(p.name) ?? id,
          parentId: ROOT_ID,
          location: str(p.location),
          state: state(img),
          facts: compact([
            fact('Location', str(p.location)),
            fact('Size', unit(p.size, 'GB')),
            fact('Licence', str(p.licenceType)),
            fact('Cloud-init', str(p.cloudInit)),
            ...metaFacts(img),
          ]),
          terms: compact([str(p.description)]),
          raw: img,
        })
      }),
    )
  }

  private datacenter(dc: Obj) {
    const id = str(dc.id)
    if (!id) return
    const p = props(dc)
    const cpus = arr(p.cpuArchitecture)
      .map((c) => str(obj(c).cpuFamily))
      .filter(Boolean)
    this.add({
      id,
      kind: 'datacenter',
      name: str(p.name) ?? id,
      parentId: ROOT_ID,
      dcId: id,
      location: str(p.location),
      state: state(dc),
      facts: compact([
        fact('Location', str(p.location)),
        fact('Description', str(p.description)),
        fact('CPU families', cpus.join(', ')),
        fact('Version', str(p.version)),
        fact('2FA protected', p.secAuthProtection === true ? 'yes' : undefined),
        ...metaFacts(dc),
      ]),
      terms: compact([str(p.description)]),
      raw: dc,
    })
  }

  private lans(d: Doc) {
    const dcId = d.params.datacenterId
    const dc = this.dcNode(dcId)
    for (const lan of items(d.doc)) {
      const p = props(lan)
      const id = this.lanId(dcId, lan.id)
      const failover = arr(p.ipFailover)
        .map((f) => str(obj(f).ip))
        .filter((ip): ip is string => !!ip)
      this.add({
        id,
        kind: 'lan',
        subtype: p.public === true ? 'public' : 'private',
        name: str(p.name) || `LAN ${str(lan.id)}`,
        parentId: dcId,
        dcId,
        location: dc?.location,
        state: state(lan),
        ips: failover,
        facts: compact([
          fact('LAN ID', str(lan.id)),
          fact('Type', p.public === true ? 'Public (internet)' : 'Private'),
          fact('Failover IPs', failover.join(', ')),
          fact('IPv6', str(p.ipv6CidrBlock)),
          ...metaFacts(lan),
        ]),
        raw: lan,
      })
      const pcc = str(p.pcc)
      if (pcc) this.pendingPCC.push({ lan: id, pcc })
    }
  }

  private volume(v: Obj, dcId: string, serverId?: string): string | undefined {
    const id = str(v.id)
    if (!id) return undefined
    const p = props(v)
    const image = str(p.image)
    const imageName = image ? this.images.get(image) : undefined
    const dc = this.dcNode(dcId)
    this.add({
      id,
      kind: 'volume',
      subtype: str(p.type),
      name: str(p.name) || id,
      parentId: dcId,
      dcId,
      location: dc?.location,
      state: state(v),
      facts: compact([
        fact('Type', str(p.type)),
        fact('Size', unit(p.size, 'GB')),
        fact('Image', imageName ?? str(p.imageAlias) ?? image),
        fact('Licence', str(p.licenceType)),
        fact('Bus', str(p.bus)),
        fact('Availability zone', str(p.availabilityZone)),
        ...metaFacts(v),
      ]),
      terms: compact([imageName, str(p.imageAlias)]),
      raw: v,
    })
    if (image) this.edge('uses-image', id, image)
    const boot = str(p.bootServer) ?? serverId
    if (boot) this.edge('attached', boot, id)
    return id
  }

  private server(s: Obj, dcId: string) {
    const id = str(s.id)
    if (!id) return
    const p = props(s)
    const dc = this.dcNode(dcId)
    const type = str(p.type)
    const template = str(p.templateUuid)
    const templateName = template ? (this.templates.get(template) ?? template) : undefined

    const volumes = entityItems(s, 'volumes').map((v) => this.volume(v, dcId, id))
    const bootVolume = str(obj(p.bootVolume).id)
    const nics = entityItems(s, 'nics')
    const server = this.add({
      id,
      kind: 'server',
      subtype: type,
      name: str(p.name) || id,
      parentId: dcId,
      dcId,
      location: dc?.location,
      state: str(p.vmState) ?? state(s),
      facts: compact([
        fact('Type', subtypeLabel('server', type)),
        fact('Template', templateName),
        fact('Cores', str(p.cores)),
        fact('RAM', gb(p.ram)),
        fact('CPU family', str(p.cpuFamily)),
        fact('VM state', str(p.vmState)),
        fact('Availability zone', str(p.availabilityZone)),
        fact('Boot volume', bootVolume ? this.nodes.get(bootVolume)?.name : undefined),
        fact('Volumes', volumes.length ? String(volumes.length) : undefined),
        fact('NICs', nics.length ? String(nics.length) : undefined),
        ...metaFacts(s),
      ]),
      terms: compact([templateName]),
      raw: s,
    })
    this.securedBy(s, id, dcId)

    for (const nic of nics) {
      const nicId = str(nic.id)
      if (!nicId) continue
      const np = props(nic)
      const lan = this.lanId(dcId, np.lan)
      const ips = strs(np.ips)
      const mac = str(np.mac)
      const rules = entityItems(nic, 'firewallrules')
      this.add({
        id: nicId,
        kind: 'nic',
        name: str(np.name) || `${server.name} ${mac ?? nicId}`,
        parentId: id,
        dcId,
        location: dc?.location,
        state: state(nic),
        ips: [...ips, ...strs(np.ipv6Ips)],
        macs: mac ? [mac] : [],
        dhcp: typeof np.dhcp === 'boolean' ? np.dhcp : undefined,
        facts: compact([
          fact('Server', server.name),
          fact('LAN', this.lanName(dcId, np.lan)),
          fact('IPs', ips.join(', ')),
          fact('MAC', mac),
          fact('DHCP', np.dhcp === true ? 'yes' : np.dhcp === false ? 'no' : undefined),
          fact('Firewall', np.firewallActive === true ? `active (${str(np.firewallType) ?? 'INGRESS'})` : 'inactive'),
          fact('Firewall rules', rulesSummary(rules)),
          ...metaFacts(nic),
        ]),
        terms: rules.map((r) => str(props(r).name) ?? ''),
        raw: nic,
      })
      this.securedBy(nic, nicId, dcId)
      server.ips.push(...ips)
      if (mac) server.macs.push(mac)
      this.edge('attached', nicId, lan)
      this.edge('member', id, lan, ips.join(', ') || undefined)
      const lanNode = this.nodes.get(lan)
      for (const ip of ips) {
        if (lanNode?.subtype === 'public') this.publicIPs.set(ip, nicId)
        else {
          const m = this.lanIPs.get(lan) ?? new Map<string, string>()
          m.set(ip, nicId)
          this.lanIPs.set(lan, m)
        }
      }
    }
  }

  private natGateway(n: Obj, dcId: string) {
    const id = str(n.id)
    if (!id) return
    const p = props(n)
    const dc = this.dcNode(dcId)
    const publicIps = strs(p.publicIps)
    const lans = arr(p.lans).map(obj)
    const rules = entityItems(n, 'rules')
    this.add({
      id,
      kind: 'natgateway',
      name: str(p.name) || id,
      parentId: dcId,
      dcId,
      location: dc?.location,
      state: state(n),
      ips: [...publicIps, ...lans.flatMap((l) => strs(l.gatewayIps).map(stripCidr))],
      facts: compact([
        fact('Public IPs', publicIps.join(', ')),
        fact('LANs', lans.map((l) => `${this.lanName(dcId, l.id)} (${strs(l.gatewayIps).join(', ')})`).join('; ')),
        fact('Rules', String(rules.length)),
        ...metaFacts(n),
      ]),
      terms: rules.map((r) => str(props(r).name) ?? ''),
      raw: n,
    })
    publicIps.forEach((ip) => this.publicIPs.set(ip, id))
    for (const l of lans) this.edge('gateway', id, this.lanId(dcId, l.id), strs(l.gatewayIps).join(', ') || undefined)
  }

  private loadBalancer(lb: Obj, dcId: string, kind: 'nlb' | 'alb', albTargetLANs: Map<string, string>) {
    const id = str(lb.id)
    if (!id) return
    const p = props(lb)
    const dc = this.dcNode(dcId)
    const ips = strs(p.ips)
    const listener = this.lanId(dcId, p.listenerLan)
    const target = this.lanId(dcId, p.targetLan)
    const rules = entityItems(lb, 'forwardingrules')
    this.add({
      id,
      kind,
      name: str(p.name) || id,
      parentId: dcId,
      dcId,
      location: dc?.location,
      state: state(lb),
      ips: [...ips, ...strs(p.lbPrivateIps).map(stripCidr)],
      facts: compact([
        fact('IPs', ips.join(', ')),
        fact('Listener LAN', this.lanName(dcId, p.listenerLan)),
        fact('Target LAN', this.lanName(dcId, p.targetLan)),
        fact('Private IPs', strs(p.lbPrivateIps).join(', ')),
        fact(
          'Forwarding rules',
          rules
            .map((r) => {
              const rp = props(r)
              return `${str(rp.name) ?? '?'} ${str(rp.protocol) ?? ''} ${str(rp.listenerIp) ?? ''}:${str(rp.listenerPort) ?? ''}`.trim()
            })
            .join('; '),
        ),
        ...metaFacts(lb),
      ]),
      terms: rules.map((r) => str(props(r).name) ?? ''),
      raw: lb,
    })
    ips.forEach((ip) => this.publicIPs.set(ip, id))
    this.edge('listener', id, listener)
    this.edge('target-lan', id, target)
    for (const r of rules) {
      const rp = props(r)
      for (const t of arr(rp.targets).map(obj)) this.lbTarget(id, target, t)
      for (const h of arr(rp.httpRules).map(obj)) {
        const tg = str(h.targetGroup)
        if (!tg) continue
        this.edge('forwards-to', id, tg, str(h.name))
        albTargetLANs.set(tg, target)
      }
    }
  }

  private lbTarget(from: string, lan: string, t: Obj) {
    const ip = str(t.ip)
    if (!ip) return
    const nic = this.lanIPs.get(lan)?.get(ip)
    const server = nic ? this.nodes.get(nic)?.parentId : undefined
    if (server) this.edge('target', from, server, `${ip}:${str(t.port) ?? ''}`)
  }

  private targetGroup(tg: Obj, albTargetLANs: Map<string, string>) {
    const id = str(tg.id)
    if (!id) return
    const p = props(tg)
    const targets = arr(p.targets).map(obj)
    const lan = albTargetLANs.get(id)
    const lanNode = lan ? this.nodes.get(lan) : undefined
    this.add({
      id,
      kind: 'targetgroup',
      name: str(p.name) || id,
      parentId: lanNode?.dcId ?? ROOT_ID,
      dcId: lanNode?.dcId,
      location: lanNode?.location,
      state: state(tg),
      ips: targets.flatMap((t) => str(t.ip) ?? []),
      facts: compact([
        fact('Protocol', str(p.protocol)),
        fact('Algorithm', str(p.algorithm)),
        fact('Targets', targets.map((t) => `${str(t.ip)}:${str(t.port)}`).join(', ')),
        fact('Health check', str(obj(p.httpHealthCheck).path)),
        ...metaFacts(tg),
      ]),
      raw: tg,
    })
    if (lan) targets.forEach((t) => this.lbTarget(id, lan, t))
  }

  private pcc(c: Obj) {
    const id = str(c.id)
    if (!id) return
    const p = props(c)
    const peers = arr(p.peers).map(obj)
    const invisible: string[] = []
    for (const peer of peers) {
      const dcId = str(peer.datacenterId)
      if (!dcId) continue
      const lan = this.lanId(dcId, peer.id)
      if (this.nodes.has(lan)) this.edge('cross-connect', lan, id)
      else invisible.push(`${str(peer.datacenterName) ?? dcId} / ${str(peer.name) ?? str(peer.id)}`)
    }
    // Not the same as peers we cannot see: the API lists every peer, even in
    // datacenters the token cannot read.
    const status = !peers.length
      ? (['unused', 'No LAN is connected to this Cross Connect.'] as const)
      : peers.length === 1
        ? (['one LAN', 'Only one LAN is connected, so it links nothing yet.'] as const)
        : undefined
    this.add({
      id,
      kind: 'pcc',
      subtype: status?.[0],
      name: str(p.name) || id,
      parentId: ROOT_ID,
      location: str(obj(peers[0]).location),
      state: state(c),
      facts: compact([
        fact('Status', status?.[1]),
        fact('Description', str(p.description)),
        fact('Peers', String(peers.length)),
        fact('Peer LANs', peers.map((pr) => `${str(pr.datacenterName) ?? '?'} / ${str(pr.name) ?? str(pr.id)}`).join('; ')),
        fact('Peers not visible', invisible.join('; ')),
        ...metaFacts(c),
      ]),
      terms: compact([str(p.description)]),
      raw: c,
    })
  }

  /** LANs reference their Cross Connect too; covers PCCs we could not list. */
  private linkLANsToPCCs() {
    for (const { lan, pcc } of this.pendingPCC) {
      if (!this.nodes.has(pcc)) {
        this.add({ id: pcc, kind: 'pcc', name: `Cross Connect ${pcc.slice(0, 8)}`, parentId: ROOT_ID, placeholder: true })
      }
      this.edge('cross-connect', lan, pcc)
    }
  }

  private ipBlock(b: Obj) {
    const id = str(b.id)
    if (!id) return
    const p = props(b)
    const ips = strs(p.ips)
    const consumers = arr(p.ipConsumers).map(obj)
    let used = 0
    for (const ip of ips) {
      const consumer = consumers.find((c) => str(c.ip) === ip)
      const target = this.publicIPs.get(ip) ?? str(consumer?.nicId) ?? str(consumer?.datacenterId)
      if (target && this.nodes.has(target)) this.edge('consumer', id, target, ip)
      if (target || consumer) used++
    }
    this.add({
      id,
      kind: 'ipblock',
      name: str(p.name) || id,
      parentId: ROOT_ID,
      location: str(p.location),
      state: state(b),
      ips,
      facts: compact([
        fact('Location', str(p.location)),
        fact('IPs', ips.join(', ')),
        fact('In use', `${used} of ${ips.length}`),
        ...metaFacts(b),
      ]),
      raw: b,
    })
  }

  private k8s(c: Obj) {
    const id = str(c.id)
    if (!id) return
    const p = props(c)
    this.add({
      id,
      kind: 'k8s',
      name: str(p.name) || id,
      parentId: ROOT_ID,
      location: str(p.location),
      state: state(c),
      facts: compact([
        fact('Kubernetes version', str(p.k8sVersion)),
        fact('API allow list', strs(p.apiSubnetAllowList).join(', ')),
        fact('Maintenance', maintenance(p.maintenanceWindow)),
        ...metaFacts(c),
      ]),
      raw: c,
    })
  }

  private nodePool(np: Obj, clusterId: string) {
    const id = str(np.id)
    if (!id) return
    const p = props(np)
    const dcId = str(p.datacenterId)
    const dc = this.dcNode(dcId)
    if (!this.nodes.has(clusterId)) {
      this.add({ id: clusterId, kind: 'k8s', name: `Cluster ${clusterId.slice(0, 8)}`, parentId: ROOT_ID, placeholder: true })
    }
    const lans = arr(p.lans).map(obj)
    this.add({
      id,
      kind: 'nodepool',
      name: str(p.name) || id,
      parentId: clusterId,
      dcId,
      location: dc?.location,
      state: state(np),
      ips: strs(p.publicIps),
      labels: Object.fromEntries(Object.entries(obj(p.labels)).flatMap(([k, v]) => (str(v) ? [[k, str(v)!]] : []))),
      facts: compact([
        fact('Cluster', this.nodes.get(clusterId)?.name),
        fact('Datacenter', dc?.name ?? dcId),
        fact('Nodes', str(p.nodeCount)),
        fact('Cores per node', str(p.coresCount)),
        fact('RAM per node', gb(p.ramSize)),
        fact('Storage', `${str(p.storageSize) ?? '?'} GB ${str(p.storageType) ?? ''}`.trim()),
        fact('Kubernetes version', str(p.k8sVersion)),
        fact('LANs', dcId ? lans.map((l) => this.lanName(dcId, l.id)).join(', ') : undefined),
        ...metaFacts(np),
      ]),
      raw: np,
    })
    if (dcId) lans.forEach((l) => this.edge('member', id, this.lanId(dcId, l.id)))
  }

  /** PostgreSQL v2 (regional), and v1 (global, shut down 2026) for older snapshots. */
  /** Network Security Groups: firewall rule sets shared by servers and NICs. */
  private securityGroup(g: Obj, dcId: string) {
    const id = str(g.id)
    if (!id || this.nodes.get(id)?.placeholder === false) return
    const p = props(g)
    const dc = this.dcNode(dcId)
    const rules = entityItems(g, 'rules')
    this.add({
      id,
      kind: 'securitygroup',
      name: str(p.name) || id,
      parentId: dc ? dcId : ROOT_ID,
      dcId: dc ? dcId : undefined,
      location: dc?.location,
      state: state(g),
      facts: compact([fact('Description', str(p.description)), fact('Rules', rulesSummary(rules)), ...metaFacts(g)]),
      terms: compact([str(p.description), ...rules.map((r) => str(props(r).name))]),
      raw: g,
    })
    for (const m of [...entityItems(g, 'servers'), ...entityItems(g, 'nics')]) this.edge('secured-by', str(m.id), id)
  }

  /** Edges from a server or NIC to its Security Groups (also adds groups the list missed). */
  private securedBy(o: Obj, from: string, dcId: string) {
    for (const g of entityItems(o, 'securitygroups')) {
      const id = str(g.id)
      if (!id) continue
      if (!this.nodes.has(id) && isObj(g.properties)) this.securityGroup(g, dcId)
      this.edge('secured-by', from, id)
    }
  }

  private postgres(c: Obj, api: string) {
    const id = str(c.id)
    if (!id) return
    const p = props(c)
    const meta = obj(c.metadata)
    const v2 = isObj(p.instances) || isObj(p.connection)
    const inst = obj(p.instances)
    const conns = (isObj(p.connection) ? [p.connection] : arr(p.connections)).map(obj)
    const addr = (x: Obj) => str(x.primaryInstanceAddress) ?? str(x.cidr)
    const dcId = str(conns[0]?.datacenterId)
    const region = this.snapshot.manifest.apis.find((a) => a.id === api)?.region
    const dnsName = str(meta.dnsName) ?? str(p.dnsName)
    // v2 sizes are GB per instance, v1 sizes were MB.
    const size = (v: unknown) => (v2 ? (num(v) !== undefined ? `${num(v)} GB` : undefined) : gb(v))
    const backup = obj(p.backup)
    this.add({
      id,
      kind: 'postgres',
      name: str(p.name) || str(p.displayName) || id,
      parentId: ROOT_ID,
      dcId,
      location: str(p.location) ?? this.dcNode(dcId)?.location ?? region?.replace('-', '/'),
      state: state(c),
      ips: compact(conns.map((x) => (addr(x) ? stripCidr(addr(x)!) : undefined))),
      facts: compact([
        fact('PostgreSQL', str(p.version) ?? str(p.postgresVersion)),
        fact('Description', str(p.description)),
        fact('Status', str(meta.statusMessage)),
        fact('Instances', str(inst.count) ?? str(p.instances)),
        fact('Cores', str(inst.cores) ?? str(p.cores)),
        fact('RAM', size(inst.ram ?? p.ram)),
        fact('Storage', `${size(inst.storageSize ?? p.storageSize) ?? '?'} ${str(p.storageType) ?? ''}`.trim()),
        fact('Replication', str(p.replicationMode) ?? str(p.synchronizationMode)),
        fact('Connection pooler', str(p.connectionPooler)),
        fact('DNS name', dnsName),
        fact(
          'Connections',
          conns
            .map(
              (x) =>
                `${this.dcNode(str(x.datacenterId))?.name ?? str(x.datacenterId)} / ${this.lanName(str(x.datacenterId) ?? '', x.lanId)} (${addr(x)})`,
            )
            .join('; '),
        ),
        fact(
          'Backups',
          str(backup.location)
            ? `${str(backup.location)}${num(backup.retentionDays) ? `, kept ${num(backup.retentionDays)} days` : ''}`
            : str(p.backupLocation),
        ),
        fact('Maintenance', maintenance(p.maintenanceWindow)),
        ...metaFacts(c),
      ]),
      terms: compact([dnsName]),
      raw: c,
    })
    for (const x of conns) {
      const dc = str(x.datacenterId)
      if (dc) this.edge('connection', id, this.lanId(dc, x.lanId), addr(x))
    }
  }

  // --- more managed services ------------------------------------------------------

  private region(api: string) {
    return this.snapshot.manifest.apis.find((a) => a.id === api)?.region
  }

  /** "fra-prod-data / db (10.7.3.4/24)"; several joined by "; ". */
  private connectionsFact(conns: Obj[], addrs: (x: Obj) => string[]) {
    return conns
      .map((x) => {
        const dc = str(x.datacenterId) ?? ''
        const a = addrs(x).join(', ')
        return `${this.dcNode(dc)?.name ?? dc} / ${this.lanName(dc, x.lanId ?? x.lan)}${a ? ` (${a})` : ''}`
      })
      .join('; ')
  }

  /** A `connection` edge to each LAN; LAN ids are `lanId`, or `lan` (Network File Storage). */
  private connect(id: string, conns: Obj[], addrs: (x: Obj) => string[]) {
    for (const x of conns) {
      const dc = str(x.datacenterId)
      if (dc) this.edge('connection', id, this.lanId(dc, x.lanId ?? x.lan), addrs(x).join(', ') || undefined)
    }
  }

  /**
   * MariaDB and In-Memory DB (v2: one `connection`, sizes in GB per
   * instance) and MongoDB (`connections` with a CIDR list, sizes in MB).
   */
  private database(c: Obj, api: string, kind: 'mariadb' | 'inmemorydb' | 'mongodb') {
    const id = str(c.id)
    if (!id) return
    const p = props(c)
    const meta = obj(c.metadata)
    const inst = obj(p.instances)
    const conns = (isObj(p.connection) ? [p.connection] : arr(p.connections)).map(obj)
    const addrs = (x: Obj) => (str(x.primaryInstanceAddress) ? [str(x.primaryInstanceAddress)!] : strs(x.cidrList))
    const dcId = str(conns[0]?.datacenterId)
    const region = this.region(api)
    const product = LAN_SERVICES.get(kind)!
    const host = str(meta.dnsName) ?? hostOf(str(p.connectionString))
    const size = (v: unknown) => (kind === 'mongodb' ? gb(v) : unit(v, 'GB'))
    const backup = isObj(p.snapshot) ? obj(p.snapshot) : obj(p.backup)
    const creds = obj(p.credentials)
    this.add({
      id,
      kind,
      name: str(p.name) || str(p.displayName) || id,
      parentId: ROOT_ID,
      dcId,
      location: str(p.location) ?? this.dcNode(dcId)?.location ?? region?.replace('-', '/'),
      state: state(c),
      ips: conns.flatMap(addrs).map(stripCidr),
      facts: compact([
        fact(product, str(p.version) ?? str(p.mongoDBVersion)),
        fact('Description', str(p.description)),
        fact('Status', str(meta.statusMessage)),
        fact('Health', str(meta.health)),
        fact('Type', str(p.type)),
        fact('Edition', str(p.edition)),
        fact('Instances', str(inst.count) ?? str(p.instances)),
        fact('Shards', num(p.shards) ? str(p.shards) : undefined),
        fact('Cores', str(inst.cores) ?? str(p.cores)),
        fact('RAM', size(inst.ram ?? p.ram)),
        fact('Storage', size(inst.storageSize ?? p.storageSize)),
        fact('Persistence', str(p.persistenceMode)),
        fact('Eviction', str(p.evictionPolicy)),
        fact('Host', host),
        fact('Connection string', str(p.connectionString)),
        fact('Database', str(creds.database)),
        fact('User', str(creds.username)),
        fact('Connections', this.connectionsFact(conns, addrs)),
        fact(
          kind === 'inmemorydb' ? 'Snapshots' : 'Backups',
          str(backup.location) && `${str(backup.location)}${num(backup.retentionDays) ? `, kept ${num(backup.retentionDays)} days` : ''}`,
        ),
        fact('Maintenance', maintenance(p.maintenanceWindow)),
        ...metaFacts(c),
      ]),
      terms: compact([host, str(p.description), str(p.connectionString)]),
      raw: c,
    })
    this.connect(id, conns, addrs)
    if (host) this.hosts.set(host, id)
  }

  private kafka(c: Obj, api: string) {
    const id = str(c.id)
    if (!id) return
    const p = props(c)
    const meta = obj(c.metadata)
    const conns = arr(p.connections).map(obj)
    const addrs = (x: Obj) => strs(x.brokerAddresses)
    const dcId = str(conns[0]?.datacenterId)
    this.add({
      id,
      kind: 'kafka',
      name: str(p.name) || id,
      parentId: ROOT_ID,
      dcId,
      location: this.dcNode(dcId)?.location ?? this.region(api)?.replace('-', '/'),
      state: state(c),
      ips: conns.flatMap(addrs).map(stripCidr),
      facts: compact([
        fact('Kafka', str(p.version)),
        fact('Size', str(p.size)),
        fact('Status', str(meta.message)),
        fact('Brokers', strs(meta.brokerAddresses).join(', ')),
        fact('Connections', this.connectionsFact(conns, addrs)),
        ...metaFacts(c),
      ]),
      raw: c,
    })
    this.connect(id, conns, addrs)
  }

  /** Topics are listed in the cluster's facts and found by its search, not drawn. */
  private kafkaTopics(clusterId: string, topics: Obj[]) {
    const n = this.nodes.get(clusterId)
    if (!n || !topics.length) return
    const describe = (t: Obj) => {
      const p = props(t)
      const ms = num(obj(p.logRetention).retentionTime)
      const kept = ms === undefined ? '' : ms < 0 ? ', kept forever' : `, kept ${duration(ms)}`
      return `${str(p.name) ?? '?'} (${str(p.numberOfPartitions) ?? '?'} partitions × ${str(p.replicationFactor) ?? '?'}${kept})`
    }
    insertFact(n, fact(`Topics (${topics.length})`, topics.map(describe).join(', ')))
    n.terms.push(...topics.flatMap((t) => str(props(t).name) ?? []))
  }

  private nfs(c: Obj, api: string) {
    const id = str(c.id)
    if (!id) return
    const p = props(c)
    const meta = obj(c.metadata)
    const conns = arr(p.connections).map(obj)
    const addrs = (x: Obj) => (str(x.ipAddress) ? [str(x.ipAddress)!] : [])
    const dcId = str(conns[0]?.datacenterId)
    this.add({
      id,
      kind: 'nfs',
      name: str(p.name) || id,
      parentId: ROOT_ID,
      dcId,
      location: this.dcNode(dcId)?.location ?? this.region(api)?.replace('-', '/'),
      state: state(c),
      ips: conns.flatMap(addrs).map(stripCidr),
      facts: compact([
        fact('NFS', str(obj(p.nfs).minVersion)),
        fact('Size', str(p.size) && `${str(p.size)} ${str(p.sizeUnit) ?? ''}`.trim()),
        fact('Used', bytes(meta.used)),
        fact('Status', str(meta.statusMessage)),
        fact('Connections', this.connectionsFact(conns, addrs)),
        ...metaFacts(c),
      ]),
      raw: c,
    })
    this.connect(id, conns, addrs)
  }

  private nfsShare(sh: Obj, clusterId: string) {
    const id = str(sh.id)
    if (!id) return
    const p = props(sh)
    const meta = obj(sh.metadata)
    const cluster = this.nodes.get(clusterId)
    const groups = arr(p.clientGroups).map(obj)
    const quota = num(p.quota)
    const clients = groups
      .map((g) => {
        const who = [...strs(g.ipNetworks), ...strs(g.hosts)].join(', ') || 'nobody'
        const squash = str(obj(g.nfs).squash)
        return `${str(g.description) ? `${str(g.description)}: ` : ''}${who}${squash ? ` (squash ${squash})` : ''}`
      })
      .join('; ')
    this.add({
      id,
      kind: 'nfsshare',
      name: str(p.name) || id,
      parentId: cluster ? clusterId : ROOT_ID,
      dcId: cluster?.dcId,
      location: cluster?.location,
      state: state(sh),
      facts: compact([
        fact('Cluster', cluster?.name),
        fact('Path', str(meta.nfsPath) && `${cluster?.ips[0] ? `${cluster.ips[0]}:` : ''}${str(meta.nfsPath)}`),
        fact('Quota', quota === undefined ? undefined : quota === 0 ? 'unlimited' : gb(quota)),
        fact('Used', bytes(meta.used)),
        fact('Owner', p.uid !== undefined ? `uid ${str(p.uid)}, gid ${str(p.gid) ?? '?'}` : undefined),
        fact('Clients', clients),
        ...metaFacts(sh),
      ]),
      terms: groups.flatMap((g) => compact([str(g.description), ...strs(g.ipNetworks), ...strs(g.hosts)])),
      raw: sh,
    })
  }

  /** A VM Auto Scaling group: the template of the servers it creates, and the LANs they join. */
  private autoscaling(g: Obj) {
    const id = str(g.id)
    if (!id) return
    const p = props(g)
    const dcId = str(obj(p.datacenter).id)
    const dc = this.dcNode(dcId)
    const rc = obj(p.replicaConfiguration)
    const nics = arr(rc.nics).map(obj)
    const policy = obj(p.policy)
    this.add({
      id,
      kind: 'autoscaling',
      name: str(p.name) || id,
      parentId: dc ? dc.id : ROOT_ID,
      dcId: dc?.id,
      location: str(p.location) ?? dc?.location,
      state: state(g),
      facts: compact([
        fact('Servers', p.minReplicaCount !== undefined ? `${str(p.minReplicaCount)} to ${str(p.maxReplicaCount) ?? '?'}` : undefined),
        fact(
          'Each server',
          compact([unit(rc.cores, 'cores'), gb(rc.ram), str(rc.cpuFamily)]).join(', ') || undefined,
        ),
        fact('LANs', nics.map((n) => (dcId ? this.lanName(dcId, n.lan) : str(n.lan))).join(', ')),
        fact(
          'Scales',
          str(policy.metric) &&
            `on ${str(policy.metric)}: out above ${str(policy.scaleOutThreshold) ?? '?'}, in below ${str(policy.scaleInThreshold) ?? '?'}`,
        ),
        ...metaFacts(g),
      ]),
      raw: g,
    })
    if (dcId) for (const n of nics) this.edge('connection', id, this.lanId(dcId, n.lan), str(n.name))
  }

  private autoscalingServers(groupId: string, list: Obj[]) {
    for (const x of list) this.edge('manages', groupId, str(obj(props(x).datacenterServer).id))
  }

  private backupUnit(b: Obj) {
    const id = str(b.id)
    if (!id) return
    const p = props(b)
    this.add({
      id,
      kind: 'backupunit',
      name: str(p.name) || id,
      parentId: ROOT_ID,
      state: state(b),
      facts: compact([fact('Email', str(p.email)), ...metaFacts(b)]),
      terms: compact([str(p.email)]),
      raw: b,
    })
  }

  private volumeSnapshot(x: Obj) {
    const id = str(x.id)
    if (!id) return
    const p = props(x)
    this.add({
      id,
      kind: 'snapshot',
      name: str(p.name) || id,
      parentId: ROOT_ID,
      location: str(p.location),
      state: state(x),
      facts: compact([
        fact('Description', str(p.description)),
        fact('Location', str(p.location)),
        fact('Size', unit(p.size, 'GB')),
        fact('Licence', str(p.licenceType)),
        ...metaFacts(x),
      ]),
      terms: compact([str(p.description)]),
      raw: x,
    })
  }

  private registry(r: Obj) {
    const id = str(r.id)
    if (!id) return
    const p = props(r)
    const host = str(p.hostname)
    const gc = obj(p.garbageCollectionSchedule)
    const scanning = obj(obj(p.features).vulnerabilityScanning).enabled
    this.add({
      id,
      kind: 'registry',
      name: str(p.name) || id,
      parentId: ROOT_ID,
      location: str(p.location),
      state: state(r),
      facts: compact([
        fact('Host', host),
        fact('Location', str(p.location)),
        fact('Storage used', bytes(obj(p.storageUsage).bytes)),
        fact('Garbage collection', strs(gc.days).length ? `${strs(gc.days).join(', ')} ${str(gc.time) ?? ''}`.trim() : undefined),
        fact('Vulnerability scanning', typeof scanning === 'boolean' ? (scanning ? 'on' : 'off') : undefined),
        fact('API allowed from', strs(p.apiSubnetAllowList).join(', ')),
        ...metaFacts(r),
      ]),
      terms: compact([host]),
      raw: r,
    })
    if (host) this.hosts.set(host, id)
  }

  /** Repositories are listed in the registry's facts and found by its search. */
  private repositories(registryId: string, repos: Obj[]) {
    const n = this.nodes.get(registryId)
    if (!n || !repos.length) return
    const describe = (x: Obj) => {
      const m = obj(x.metadata)
      const pushed = str(m.lastPushedAt)?.slice(0, 10)
      const extra = compact([unit(m.artifactCount, 'artifacts'), pushed && `last push ${pushed}`, str(m.lastSeverity) && `worst finding ${str(m.lastSeverity)}`])
      return `${str(props(x).name) ?? '?'}${extra.length ? ` (${extra.join(', ')})` : ''}`
    }
    insertFact(n, fact(`Repositories (${repos.length})`, repos.map(describe).join('; ')))
    n.terms.push(...repos.flatMap((x) => str(props(x).name) ?? []))
  }

  /** Logging and Monitoring Service pipelines: where logs or metrics go in, and where to look at them. */
  private pipeline(x: Obj, api: string, flavor: 'Logging' | 'Monitoring') {
    const id = str(x.id)
    if (!id) return
    const p = props(x)
    const meta = obj(x.metadata)
    const region = this.region(api)
    const logs = arr(p.logs).map(obj)
    const endpoints = compact([str(p.httpAddress), str(p.tcpAddress), str(meta.httpEndpoint)])
    const grafana = str(p.grafanaAddress) ?? str(meta.grafanaEndpoint)
    this.add({
      id,
      kind: 'pipeline',
      subtype: flavor,
      name: str(p.name) || id,
      parentId: ROOT_ID,
      location: region?.replace('-', '/'),
      state: state(x),
      facts: compact([
        fact('Service', `${flavor} Service${region ? ` in ${region}` : ''}`),
        fact(
          'Logs',
          logs
            .map((l) => {
              const keep = arr(l.destinations)
                .map(obj)
                .map((d) => num(d.retentionInDays))
                .find((n) => n !== undefined)
              return `${str(l.source) ?? '?'}${str(l.tag) ? ` "${str(l.tag)}"` : ''} via ${str(l.protocol) ?? '?'}${keep ? `, kept ${keep} days` : ''}`
            })
            .join('; '),
        ),
        fact('Send to', endpoints.join(', ')),
        fact('Grafana', grafana),
        fact('Tier', str(p.resourceTier)),
        fact('Status', str(meta.statusMessage)),
        ...metaFacts(x),
      ]),
      terms: compact([...endpoints, grafana, ...logs.map((l) => str(l.tag))]),
      raw: x,
    })
  }

  /** Validity is judged by the snapshot's date: what was true when it was taken. */
  private certificate(c: Obj) {
    const id = str(c.id)
    if (!id) return
    const p = props(c)
    const meta = obj(c.metadata)
    const cn = str(meta.commonName)
    const sans = strs(meta.subjectAlternativeNames)
    const until = str(meta.notAfter)
    const days = until ? daysBetween(this.snapshot.manifest.createdAt, until) : undefined
    const expired = meta.expired === true || (days !== undefined && days <= 0)
    const flags = expired ? ['expired', 'expiring'] : days !== undefined && days <= 30 ? ['expiring'] : undefined
    // Relative to the snapshot, so not compared between snapshots (diff.ts).
    const expires = days === undefined ? undefined : expired ? `expired ${-days} days before the snapshot` : `${days} days after the snapshot`
    this.add({
      id,
      kind: 'certificate',
      subtype: str(meta.autoCertificate) ? 'renewed automatically' : undefined,
      name: str(p.name) || cn || id,
      parentId: ROOT_ID,
      state: expired ? 'EXPIRED' : state(c),
      flags,
      facts: compact([
        fact('Common name', cn),
        fact('Also valid for', sans.filter((x) => x !== cn).join(', ')),
        fact('Valid from', str(meta.notBefore)?.slice(0, 10)),
        fact('Valid until', until?.slice(0, 10)),
        fact('Expires', expires),
        fact('Serial', str(meta.serialNumber)),
        fact('Status', str(meta.message)),
        ...metaFacts(c),
      ]),
      terms: compact([cn, ...sans]),
      raw: c,
    })
  }

  /** Certificates renewed by ACME: the order, with the certificate it last issued. */
  private autoCertificate(a: Obj) {
    const id = str(a.id)
    if (!id) return
    const p = props(a)
    const meta = obj(a.metadata)
    const cn = str(p.commonName)
    const issued = str(meta.lastIssuedCertificate)
    this.add({
      id,
      kind: 'certificate',
      subtype: 'auto-certificate',
      name: str(p.name) || cn || id,
      parentId: ROOT_ID,
      state: state(a),
      facts: compact([
        fact('Common name', cn),
        fact('Also valid for', strs(p.subjectAlternativeNames).filter((x) => x !== cn).join(', ')),
        fact('Key', str(p.keyAlgorithm)),
        fact('Current certificate', issued && (this.nodes.get(issued)?.name ?? issued)),
        fact('Status', str(meta.message)),
        ...metaFacts(a),
      ]),
      terms: compact([cn, ...strs(p.subjectAlternativeNames)]),
      raw: a,
    })
  }

  private cdn(x: Obj) {
    const id = str(x.id)
    if (!id) return
    const p = props(x)
    const meta = obj(x.metadata)
    const domain = str(p.domain)
    const rules = arr(p.routingRules).map(obj)
    const origins = compact(rules.map((r) => str(obj(r.upstream).host)))
    const ips = compact([str(meta.publicEndpointIpv4), str(meta.publicEndpointIpv6)])
    this.add({
      id,
      kind: 'cdn',
      name: domain || id,
      parentId: ROOT_ID,
      state: state(x),
      ips,
      facts: compact([
        fact('Domain', domain),
        fact('Public IPs', ips.join(', ')),
        fact(
          'Rules',
          rules
            .map((r) => {
              const u = obj(r.upstream)
              const extra = compact([u.caching === true ? 'cached' : undefined, u.waf === true ? 'WAF' : undefined, str(u.rateLimitClass) !== 'none' ? str(u.rateLimitClass) : undefined])
              return `${str(r.scheme) ?? '?'} ${str(r.prefix) ?? '/'} → ${str(u.host) ?? '?'}${extra.length ? ` (${extra.join(', ')})` : ''}`
            })
            .join('; '),
        ),
        fact('Status', str(meta.message)),
        ...metaFacts(x),
      ]),
      terms: compact([domain, ...origins]),
      raw: x,
    })
    for (const ip of ips) this.publicIPs.set(ip, id)
    if (domain) this.hosts.set(domain, id)
    this.cdnLinks.push({ id, cert: str(p.certificateId), origins })
  }

  private zone(z: Obj, secondary: boolean) {
    const id = str(z.id)
    if (!id) return
    const p = props(z)
    const meta = obj(z.metadata)
    const name = str(p.zoneName)
    if (name) this.zoneNames.push(name.toLowerCase())
    this.add({
      id,
      kind: 'dnszone',
      subtype: secondary ? 'secondary' : undefined,
      name: name || id,
      parentId: ROOT_ID,
      state: state(z),
      facts: compact([
        fact('Description', str(p.description)),
        fact('Enabled', p.enabled === false ? 'no' : undefined),
        fact('Primary name servers', strs(p.primaryIps).join(', ')),
        fact('Name servers', strs(meta.nameservers).join(', ')),
        ...metaFacts(z),
      ]),
      ips: strs(p.primaryIps),
      terms: compact([str(p.description)]),
      raw: z,
    })
  }

  private record(r: Obj) {
    const id = str(r.id)
    if (!id) return
    const p = props(r)
    const meta = obj(r.metadata)
    const zoneId = str(meta.zoneId)
    const zone = zoneId ? this.nodes.get(zoneId) : undefined
    const type = (str(p.type) ?? '').toUpperCase()
    const content = str(p.content) ?? ''
    const fqdn = (str(meta.fqdn) ?? [str(p.name), zone?.name].filter(Boolean).join('.')).replace(/\.$/, '').toLowerCase()
    const address = type === 'A' || type === 'AAAA'
    this.add({
      id,
      kind: 'dnsrecord',
      subtype: type || undefined,
      name: fqdn || id,
      parentId: zone ? zone.id : ROOT_ID,
      state: state(r),
      ips: address && isIP(content) ? [content] : [],
      facts: compact([
        fact('Type', type),
        fact(type === 'MX' || type === 'SRV' ? 'Points to' : 'Content', content),
        fact('Priority', type === 'MX' || type === 'SRV' ? str(p.priority) : undefined),
        fact('TTL', str(p.ttl) && `${str(p.ttl)} s`),
        fact('Enabled', p.enabled === false ? 'no' : undefined),
        fact('Zone', zone?.name),
        ...metaFacts(r),
      ]),
      terms: compact([content]),
      raw: r,
    })
    // What a name pointing at this one reaches: its address records, not its mail or text records.
    if (fqdn && (address || type === 'CNAME' || type === 'ALIAS')) this.fqdns.set(fqdn, [...(this.fqdns.get(fqdn) ?? []), id])
    // The host a record names: the last word (SRV: "weight port host").
    const target = address ? content : ['CNAME', 'ALIAS', 'MX', 'NS', 'SRV', 'HTTPS', 'SVCB'].includes(type) ? content.split(/\s+/).pop() : undefined
    if (target) this.dnsLinks.push({ id, type: address ? 'ip' : 'host', target: target.replace(/\.$/, '').toLowerCase() })
  }

  private reverseRecord(r: Obj) {
    const id = str(r.id)
    if (!id) return
    const p = props(r)
    const ip = str(p.ip)
    const name = str(p.name)?.replace(/\.$/, '').toLowerCase()
    this.add({
      id,
      kind: 'dnsrecord',
      subtype: 'PTR',
      name: name || ip || id,
      parentId: ROOT_ID,
      state: state(r),
      ips: ip ? [ip] : [],
      facts: compact([fact('Type', 'PTR (reverse DNS)'), fact('IP', ip), fact('Name', name), fact('Description', str(p.description)), ...metaFacts(r)]),
      terms: compact([str(p.description)]),
      raw: r,
    })
    if (ip) this.dnsLinks.push({ id, type: 'ip', target: ip })
  }

  /** The resource an IP belongs to: a server rather than its NIC; not DNS records or IP blocks, which only name it. */
  private ipOwner(ip: string): string | undefined {
    if (!this.ipIndex) {
      this.ipIndex = new Map()
      for (const n of this.nodes.values()) {
        if (n.kind === 'dnsrecord' || n.kind === 'ipblock' || n.kind === 'dnszone' || n.placeholder) continue
        const owner = n.kind === 'nic' && n.parentId && this.nodes.get(n.parentId)?.kind === 'server' ? n.parentId : n.id
        for (const x of n.ips) if (!this.ipIndex.has(x) || n.kind !== 'nic') this.ipIndex.set(x, owner)
      }
    }
    const pub = this.publicIPs.get(ip)
    const p = pub ? this.nodes.get(pub) : undefined
    if (p) return p.kind === 'nic' && p.parentId ? p.parentId : p.id
    return this.ipIndex.get(ip)
  }

  /**
   * DNS records to what they name: an IP to the resource that has it (the
   * name becomes a search term of it too), a host to the records of that
   * name or the service answering there. A record naming an IP not in the
   * contract, or a host in one of its zones that nothing answers, dangles.
   */
  private linkDNS() {
    for (const l of this.dnsLinks) {
      const rec = this.nodes.get(l.id)!
      const targets = l.type === 'ip' ? compact([this.ipOwner(l.target)]) : this.hostTargets(l.target)
      for (const t of targets) {
        this.edge('resolves-to', l.id, t, l.target)
        const n = this.nodes.get(t)
        if (n && n.kind !== 'dnsrecord') n.terms.push(rec.name)
      }
      const ours = l.type === 'ip' || this.zoneNames.some((z) => l.target === z || l.target.endsWith(`.${z}`))
      if (!targets.length && ours) {
        rec.flags = ['dangling']
        insertFact(rec, fact('Note', l.type === 'ip' ? 'No resource in this snapshot has this IP' : 'Nothing in this snapshot answers at this name'))
      }
    }
  }

  private hostTargets(host: string): string[] {
    const service = this.hosts.get(host)
    return service ? [service] : (this.fqdns.get(host) ?? [])
  }

  /** CDN distributions to their certificate and origins; application load balancers to theirs. */
  private linkCertificatesAndOrigins() {
    for (const c of this.cdnLinks) {
      if (c.cert && this.nodes.get(c.cert)?.kind === 'certificate') this.edge('uses-certificate', c.id, c.cert)
      for (const o of c.origins) {
        const host = o.toLowerCase()
        for (const t of isIP(host) ? compact([this.ipOwner(host)]) : this.hostTargets(host)) this.edge('upstream', c.id, t, o)
      }
    }
    for (const n of this.nodes.values()) {
      if (n.kind !== 'alb') continue
      for (const rule of entityItems(obj(n.raw), 'forwardingrules')) {
        for (const cert of strs(props(rule).serverCertificates)) {
          if (this.nodes.get(cert)?.kind === 'certificate') this.edge('uses-certificate', n.id, cert, str(props(rule).name))
        }
      }
    }
  }

  private vpnGateway(g: Obj, flavor: 'IPsec' | 'WireGuard', api: string) {
    const id = str(g.id)
    if (!id) return
    const p = props(g)
    const conns = arr(p.connections).map(obj)
    const firstDc = str(conns[0]?.datacenterId)
    const dc = this.dcNode(firstDc)
    const gatewayIP = str(p.gatewayIP)
    const region = this.snapshot.manifest.apis.find((a) => a.id === api)?.region
    this.add({
      id,
      kind: 'vpngateway',
      subtype: flavor,
      name: str(p.name) || id,
      parentId: dc ? dc.id : ROOT_ID,
      dcId: dc?.id,
      location: dc?.location ?? region?.replace('-', '/'),
      state: state(g),
      ips: compact([gatewayIP, ...conns.map((c) => (str(c.ipv4CIDR) ? stripCidr(str(c.ipv4CIDR)!) : undefined))]),
      facts: compact([
        fact('Type', `${flavor} VPN gateway`),
        fact('Description', str(p.description)),
        fact('Public IP', gatewayIP),
        fact(
          'Connections',
          conns
            .map(
              (c) =>
                `${this.dcNode(str(c.datacenterId))?.name ?? str(c.datacenterId)} / ${this.lanName(str(c.datacenterId) ?? '', c.lanId)} (${str(c.ipv4CIDR) ?? '?'})`,
            )
            .join('; '),
        ),
        fact('IKE version', str(p.version)),
        fact('Interface', str(p.interfaceIPv4CIDR)),
        fact('Listen port', str(p.listenPort)),
        fact('Tier', str(p.tier)),
        fact('Region', region),
        fact('Maintenance', maintenance(p.maintenanceWindow)),
        ...metaFacts(g),
      ]),
      terms: compact([str(p.description), str(p.publicKey)]),
      raw: g,
    })
    if (gatewayIP) this.publicIPs.set(gatewayIP, id)
    for (const c of conns) {
      const dcId = str(c.datacenterId)
      if (dcId) this.edge('connection', id, this.lanId(dcId, c.lanId), str(c.ipv4CIDR))
    }
  }

  private vpnTunnel(t: Obj, gatewayId: string, flavor: 'IPsec' | 'WireGuard') {
    const id = str(t.id)
    if (!id) return
    const p = props(t)
    const gw = this.nodes.get(gatewayId)
    const endpoint = obj(p.endpoint)
    const host = flavor === 'IPsec' ? str(p.remoteHost) : str(endpoint.host)
    const networks = flavor === 'IPsec' ? strs(p.peerNetworkCIDRs) : strs(p.allowedIPs)
    const crypto = (o: unknown) => {
      const c = obj(o)
      return compact([str(c.encryptionAlgorithm), str(c.integrityAlgorithm), str(c.diffieHellmanGroup)]).join(' / ') || undefined
    }
    const tunnel = this.add({
      id,
      kind: 'vpntunnel',
      subtype: flavor === 'IPsec' ? 'IPsec tunnel' : 'WireGuard peer',
      name: str(p.name) || id,
      parentId: gw ? gatewayId : ROOT_ID,
      dcId: gw?.dcId,
      location: gw?.location,
      state: state(t),
      ips: host && isIP(host) ? [host] : [],
      facts: compact([
        fact('Gateway', gw?.name),
        fact('Description', str(p.description)),
        fact(
          'Remote host',
          host ? (str(endpoint.port) ? `${host}:${str(endpoint.port)}` : host) : 'none (the peer connects from anywhere)',
        ),
        fact(flavor === 'IPsec' ? 'Remote networks' : 'Allowed IPs', networks.join(', ')),
        fact('Local networks', strs(p.cloudNetworkCIDRs).join(', ')),
        fact('Authentication', str(obj(p.auth).method)),
        fact('IKE', crypto(p.ike)),
        fact('ESP', crypto(p.esp)),
        ...metaFacts(t),
      ]),
      terms: compact([str(p.description), host, ...networks, ...strs(p.cloudNetworkCIDRs), str(p.publicKey)]),
      raw: t,
    })
    if (host) this.edge('tunnel', tunnel.id, this.remoteEnd(host), host)
  }

  /** What a remote host is: a resource of this contract, or an external endpoint. */
  private remoteEnd(host: string): string {
    const local = this.publicIPs.get(host)
    if (local) {
      const n = this.nodes.get(local)
      return n?.kind === 'nic' && n.parentId ? n.parentId : local
    }
    const id = `ext:${host}`
    this.add({
      id,
      kind: 'external',
      subtype: 'Remote host',
      name: host,
      parentId: ROOT_ID,
      ips: isIP(host) ? [host] : [],
      facts: [{ label: 'What', value: 'Remote end of a VPN tunnel, outside this contract' }],
      terms: [host],
    })
    return id
  }

  private label(l: Obj) {
    const p = props(l)
    const node = this.nodes.get(str(p.resourceId) ?? '')
    const key = str(p.key)
    if (node && key) node.labels[key] = str(p.value) ?? ''
  }

  /** Fallback for endpoints without a handler: keep them searchable. */
  private generic(d: Doc) {
    const dcId = d.params.datacenterId
    const list = isObj(d.doc) && Array.isArray(d.doc.items) ? items(d.doc) : isObj(d.doc) ? [d.doc] : []
    list.forEach((it, i) => {
      const p = props(it)
      let id = str(it.id) ?? `${d.cov.api}${d.cov.path}#${i}`
      if (this.nodes.has(id)) id = `${d.cov.api}:${id}`
      this.add({
        id,
        kind: 'other',
        subtype: `${d.cov.api} ${d.cov.endpoint}`,
        name: str(p.name) ?? str(p.displayName) ?? str(it.name) ?? personName(p) ?? id,
        parentId: this.dcNode(dcId) ? dcId : ROOT_ID,
        dcId: this.dcNode(dcId) ? dcId : undefined,
        location: str(p.location) ?? this.dcNode(dcId)?.location,
        state: state(it),
        facts: compact([fact('Source', `${d.cov.api} ${d.cov.endpoint}`), ...metaFacts(it)]),
        raw: it,
      })
    })
  }

  // --- finishing -----------------------------------------------------------------

  private finish(): Model {
    for (const n of this.nodes.values()) {
      if (n.parentId && !this.nodes.has(n.parentId)) {
        this.warnings.push(`${KINDS[n.kind].label} ${n.name} references missing parent ${n.parentId}.`)
        n.parentId = ROOT_ID
      }
    }
    const children = indexChildren(this.nodes.values())
    this.edges = this.edges.filter((e) => this.nodes.has(e.from) && this.nodes.has(e.to))
    const edgesByNode = indexEdges(this.edges)

    // Datacenter summary facts need the finished tree.
    for (const n of this.nodes.values()) {
      if (n.kind !== 'datacenter') continue
      const counts = new Map<string, number>()
      for (const c of children.get(n.id) ?? []) {
        const child = this.nodes.get(c)!
        const key = child.kind === 'server' ? `${subtypeLabel('server', child.subtype)} servers` : KINDS[child.kind].plural
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      n.facts.splice(1, 0, ...[...counts].sort().map(([label, count]) => fact(label, String(count))!))
    }

    const model: Model = {
      manifest: this.snapshot.manifest,
      rootId: ROOT_ID,
      nodes: this.nodes,
      edges: this.edges,
      children,
      edgesByNode,
      coverageIssues: coverageIssues(this.snapshot.manifest.coverage),
      warnings: this.warnings,
    }
    detectAppliances(model)
    for (const n of this.nodes.values()) indexNode(n)
    return model
  }
}

/** Dedupes addresses and builds the search haystack; call after changing a node. */
export function indexNode(n: GraphNode) {
  n.ips = [...new Set(n.ips)]
  n.macs = [...new Set(n.macs)]
  n.searchText = [
    n.name,
    n.id,
    KINDS[n.kind].label,
    subtypeLabel(n.kind, n.subtype),
    n.subtype,
    n.location,
    n.state,
    ...n.ips,
    ...n.macs,
    ...Object.entries(n.labels).map(([k, v]) => `${k}=${v}`),
    ...n.terms,
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
}

export function indexEdges(edges: GraphEdge[]): Map<string, GraphEdge[]> {
  const byNode = new Map<string, GraphEdge[]>()
  for (const e of edges) {
    for (const id of [e.from, e.to]) {
      const list = byNode.get(id) ?? []
      list.push(e)
      byNode.set(id, list)
    }
  }
  return byNode
}

export function indexChildren(nodes: Iterable<GraphNode>): Map<string, string[]> {
  const children = new Map<string, string[]>()
  for (const n of nodes) {
    if (!n.parentId) continue
    const list = children.get(n.parentId) ?? []
    list.push(n.id)
    children.set(n.parentId, list)
  }
  return children
}

// --- helpers -----------------------------------------------------------------------

/** "cloudapi-v6" → "cloudapi", "mariadb-v1-de-txl" → "mariadb". */ // gitleaks:allow
export function apiFamily(api: string): string {
  return api.replace(/-v\d+(-.*)?$/, '')
}

/** Extracts `{param}` values from a concrete path; null if it does not match. */
export function matchEndpoint(template: string, path: string): Record<string, string> | null {
  const t = template.split('/')
  const p = path.split('/')
  if (t.length !== p.length) return null
  const out: Record<string, string> = {}
  for (let i = 0; i < t.length; i++) {
    if (t[i].startsWith('{') && t[i].endsWith('}')) out[t[i].slice(1, -1)] = p[i]
    else if (t[i] !== p[i]) return null
  }
  return out
}

function coverageIssues(coverage: Coverage[]): CoverageIssue[] {
  const groups = new Map<string, CoverageIssue>()
  for (const c of coverage) {
    if (c.status === 'ok') continue
    const key = `${c.api}|${c.endpoint}|${c.status}`
    const g = groups.get(key)
    if (g) g.count++
    else groups.set(key, { api: c.api, endpoint: c.endpoint, status: c.status, count: 1, error: c.error })
  }
  return [...groups.values()]
}

function fact(label: string, value: string | undefined | null): Fact | undefined {
  return value === undefined || value === null || value === '' ? undefined : { label, value }
}

function compact<T>(list: (T | undefined)[]): T[] {
  return list.filter((x): x is T => x !== undefined && x !== '')
}

function state(o: Obj) {
  // The Cloud API says state; the newer regional APIs say status.
  return str(obj(o.metadata).state) ?? str(obj(o.metadata).status)
}

function isIP(s: string) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || (s.includes(':') && /^[0-9a-f:]+$/i.test(s))
}

function metaFacts(o: Obj): (Fact | undefined)[] {
  const m = obj(o.metadata)
  const by = (date: unknown, who: unknown) => {
    const d = str(date)
    if (!d) return undefined
    const w = str(who)
    return w ? `${d.replace('T', ' ').replace('Z', ' UTC')} by ${w}` : d
  }
  return [
    fact('State', str(m.state) ?? str(m.status)),
    fact('Created', by(m.createdDate, m.createdBy)),
    fact('Modified', by(m.lastModifiedDate, m.lastModifiedBy)),
  ]
}

/** Before the State/Created/Modified facts, which close every list. */
function insertFact(n: GraphNode, f: Fact | undefined) {
  if (!f) return
  const at = n.facts.findIndex((x) => x.label === 'State' || x.label === 'Created' || x.label === 'Modified')
  n.facts.splice(at < 0 ? n.facts.length : at, 0, f)
}

/** "mongodb+srv://m-1.mongodb.de-fra.ionos.com" → "m-1.mongodb.de-fra.ionos.com". */
function hostOf(url: string | undefined) {
  const m = url && /^[a-z+]+:\/\/(?:[^@/]*@)?([^/:?,]+)/i.exec(url)
  return m ? m[1].toLowerCase() : undefined
}

function bytes(v: unknown): string | undefined {
  const n = num(v)
  if (n === undefined) return undefined
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let i = 0
  let x = n
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024
    i++
  }
  return `${i ? x.toFixed(x < 10 ? 1 : 0) : x} ${units[i]}`
}

/** Milliseconds as days or hours: "7 days", "12 hours". */
function duration(ms: number) {
  const h = ms / 3_600_000
  return h >= 48 ? `${Math.round(h / 24)} days` : `${Math.round(h)} hours`
}

/** Whole days from a to b (negative when b is earlier). */
function daysBetween(a: string, b: string): number | undefined {
  const [x, y] = [Date.parse(a), Date.parse(b)]
  return Number.isNaN(x) || Number.isNaN(y) ? undefined : Math.floor((y - x) / 86_400_000)
}

function gb(mb: unknown): string | undefined {
  const n = num(mb)
  if (n === undefined) return undefined
  const v = n / 1024
  return `${Number.isInteger(v) ? v : v.toFixed(1)} GB`
}

function unit(v: unknown, u: string) {
  const s = str(v)
  return s ? `${s} ${u}` : undefined
}

function ratio(a: unknown, b: unknown) {
  const x = str(a)
  if (!x) return undefined
  const y = str(b)
  return y ? `${x} / ${y}` : x
}

function stripCidr(ip: string) {
  return ip.replace(/\/\d+$/, '')
}

function maintenance(w: unknown) {
  const m = obj(w)
  const day = str(m.dayOfTheWeek)
  return day ? `${day} ${str(m.time) ?? ''}`.trim() : undefined
}

/** Rules at too low a depth are bare references without properties. */
function rulesSummary(rules: Obj[]) {
  if (!rules.length) return undefined
  if (rules.every((r) => !isObj(r.properties))) return `${rules.length} (contents not in this snapshot)`
  return rules.map(ruleSummary).join(', ')
}

/** Users have no name, only first name, last name and email. */
function personName(p: Obj) {
  const full = [str(p.firstname), str(p.lastname)].filter(Boolean).join(' ')
  return full || str(p.email)
}

function ruleSummary(r: Obj) {
  const p = props(r)
  const proto = str(p.protocol) ?? 'ANY'
  const from = num(p.portRangeStart)
  const to = num(p.portRangeEnd)
  const ports = from === undefined ? '' : from === to || to === undefined ? ` ${from}` : ` ${from}-${to}`
  const src = str(p.sourceIp) ? ` from ${str(p.sourceIp)}` : ''
  return `${proto}${ports}${src}`
}
