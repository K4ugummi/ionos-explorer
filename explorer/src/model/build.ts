import type { Coverage, Snapshot } from '../snapshot/types'
import { KINDS, subtypeLabel } from './kinds'
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
    this.each('cloudapi /datacenters/{datacenterId}/volumes', (d) =>
      items(d.doc).forEach((v) => this.volume(v, d.params.datacenterId)),
    )
    this.each('cloudapi /datacenters/{datacenterId}/servers', (d) =>
      items(d.doc).forEach((s) => this.server(s, d.params.datacenterId)),
    )
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
    this.each('cloudapi /ipblocks', (d) => items(d.doc).forEach((b) => this.ipBlock(b)))
    this.each('cloudapi /k8s', (d) => items(d.doc).forEach((c) => this.k8s(c)))
    this.each('cloudapi /k8s/{k8sClusterId}/nodepools', (d) =>
      items(d.doc).forEach((np) => this.nodePool(np, d.params.k8sClusterId)),
    )
    this.each('postgresql /clusters', (d) => items(d.doc).forEach((c) => this.postgres(c)))
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
    const cpus = arr(p.cpuArchitecture).map((c) => str(obj(c).cpuFamily)).filter(Boolean)
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
      const failover = arr(p.ipFailover).map((f) => str(obj(f).ip)).filter((ip): ip is string => !!ip)
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
        facts: compact([
          fact('Server', server.name),
          fact('LAN', this.lanName(dcId, np.lan)),
          fact('IPs', ips.join(', ')),
          fact('MAC', mac),
          fact('DHCP', np.dhcp === true ? 'yes' : np.dhcp === false ? 'no' : undefined),
          fact('Firewall', np.firewallActive === true ? `active (${str(np.firewallType) ?? 'INGRESS'})` : 'inactive'),
          fact('Firewall rules', rules.map(ruleSummary).join(', ')),
          ...metaFacts(nic),
        ]),
        terms: rules.map((r) => str(props(r).name) ?? ''),
        raw: nic,
      })
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
    this.add({
      id,
      kind: 'pcc',
      name: str(p.name) || id,
      parentId: ROOT_ID,
      location: str(obj(peers[0]).location),
      state: state(c),
      facts: compact([
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

  private postgres(c: Obj) {
    const id = str(c.id)
    if (!id) return
    const p = props(c)
    const conns = arr(p.connections).map(obj)
    const dcId = str(conns[0]?.datacenterId)
    const ips = conns.flatMap((x) => (str(x.cidr) ? [stripCidr(str(x.cidr)!)] : []))
    this.add({
      id,
      kind: 'postgres',
      name: str(p.displayName) || id,
      parentId: ROOT_ID,
      dcId,
      location: str(p.location),
      state: state(c),
      ips,
      facts: compact([
        fact('PostgreSQL', str(p.postgresVersion)),
        fact('Instances', str(p.instances)),
        fact('Cores', str(p.cores)),
        fact('RAM', gb(p.ram)),
        fact('Storage', `${gb(p.storageSize) ?? '?'} ${str(p.storageType) ?? ''}`.trim()),
        fact('DNS name', str(p.dnsName)),
        fact('Connections', conns.map((x) => `${this.dcNode(str(x.datacenterId))?.name ?? str(x.datacenterId)} / ${this.lanName(str(x.datacenterId) ?? '', x.lanId)} (${str(x.cidr)})`).join('; ')),
        fact('Maintenance', maintenance(p.maintenanceWindow)),
        ...metaFacts(c),
      ]),
      terms: compact([str(p.dnsName)]),
      raw: c,
    })
    for (const x of conns) {
      const dc = str(x.datacenterId)
      if (dc) this.edge('connection', id, this.lanId(dc, x.lanId), str(x.cidr))
    }
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
        name: str(p.name) ?? str(p.displayName) ?? str(it.name) ?? id,
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
    const children = new Map<string, string[]>()
    for (const n of this.nodes.values()) {
      if (n.parentId && !this.nodes.has(n.parentId)) {
        this.warnings.push(`${KINDS[n.kind].label} ${n.name} references missing parent ${n.parentId}.`)
        n.parentId = ROOT_ID
      }
      if (n.parentId) {
        const list = children.get(n.parentId) ?? []
        list.push(n.id)
        children.set(n.parentId, list)
      }
    }
    const edgesByNode = new Map<string, GraphEdge[]>()
    this.edges = this.edges.filter((e) => {
      if (!this.nodes.has(e.from) || !this.nodes.has(e.to)) return false
      for (const id of [e.from, e.to]) {
        const list = edgesByNode.get(id) ?? []
        list.push(e)
        edgesByNode.set(id, list)
      }
      return true
    })

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

    for (const n of this.nodes.values()) {
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

    return {
      manifest: this.snapshot.manifest,
      rootId: ROOT_ID,
      nodes: this.nodes,
      edges: this.edges,
      children,
      edgesByNode,
      coverageIssues: coverageIssues(this.snapshot.manifest.coverage),
      warnings: this.warnings,
    }
  }
}

// --- helpers -----------------------------------------------------------------------

/** "cloudapi-v6" → "cloudapi", "mariadb-v1-de-txl" → "mariadb". */
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
  return str(obj(o.metadata).state)
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
    fact('State', str(m.state)),
    fact('Created', by(m.createdDate, m.createdBy)),
    fact('Modified', by(m.lastModifiedDate, m.lastModifiedBy)),
  ]
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

function ruleSummary(r: Obj) {
  const p = props(r)
  const proto = str(p.protocol) ?? 'ANY'
  const from = num(p.portRangeStart)
  const to = num(p.portRangeEnd)
  const ports = from === undefined ? '' : from === to || to === undefined ? ` ${from}` : ` ${from}-${to}`
  const src = str(p.sourceIp) ? ` from ${str(p.sourceIp)}` : ''
  return `${proto}${ports}${src}`
}
