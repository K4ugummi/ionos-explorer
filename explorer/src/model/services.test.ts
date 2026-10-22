import { describe, expect, it } from 'vitest'
import { datacenterDiagram } from '../diagram/build'
import { search } from '../search/search'
import { fixtureModel } from '../test/fixture'
import { findPaths } from './paths'
import type { EdgeKind, GraphNode, Model, NodeKind } from './types'

const named = (m: Model, name: string, kind?: NodeKind) =>
  [...m.nodes.values()].find((n) => n.name === name && (!kind || n.kind === kind))!
const out = (m: Model, n: GraphNode, kind: EdgeKind) =>
  (m.edgesByNode.get(n.id) ?? []).filter((e) => e.from === n.id && e.kind === kind).map((e) => m.nodes.get(e.to)!.name)
const fact = (n: GraphNode, label: string) => n.facts.find((f) => f.label.startsWith(label))?.value
const query = (m: Model, q: string) => search(m, q).hits.map((h) => h.node.name)

describe('services beyond the Cloud API', async () => {
  const m = await fixtureModel()

  it('connects databases, Kafka and file storage to their LANs and draws them there', () => {
    for (const [name, kind, dc, lan] of [
      ['mariadb-shop', 'mariadb', 'fra-prod-data', 'db'],
      ['mariadb-erp-reports', 'mariadb', 'txl-prod-erp', 'db'],
      ['mongo-catalog', 'mongodb', 'fra-prod-data', 'db'],
      ['redis-sessions', 'inmemorydb', 'fra-prod-shop', 'web'],
      ['kafka-events', 'kafka', 'fra-prod-data', 'k8s-nodes'],
      ['nfs-tools', 'nfs', 'fra-mgmt', 'tools'],
    ] as const) {
      const n = named(m, name, kind)
      expect(m.nodes.get(n.dcId!)!.name).toBe(dc)
      expect(out(m, n, 'connection')).toEqual([lan])
      expect(n.ips.length).toBeGreaterThan(0)
      expect(datacenterDiagram(m, n.dcId!).nodes.some((b) => b.ref === n.id)).toBe(true)
    }
    expect(fact(named(m, 'mongo-catalog'), 'Host')).toMatch(/^m-[0-9a-f]{8}\.mongodb\.de-fra\.ionos\.com$/)
    expect(fact(named(m, 'kafka-events'), 'Topics (3)')).toContain('orders (12 partitions × 3, kept 7 days)')
    expect(search(m, 'audit-log').hits[0].node.name).toBe('kafka-events')
  })

  it('reaches a database over the network graph', () => {
    const [web, redis] = [named(m, 'shop-web-01'), named(m, 'redis-sessions')]
    const [p] = findPaths(m, web.id, redis.id)
    expect(p.nodes.map((id) => m.nodes.get(id)!.name)).toEqual(['shop-web-01', 'web', 'redis-sessions'])
  })

  it('lists NFS shares below their cluster, with who may mount them', () => {
    const cache = named(m, 'ci-cache', 'nfsshare')
    expect(cache.parentId).toBe(named(m, 'nfs-tools').id)
    expect(fact(cache, 'Clients')).toMatch(/^GitLab runners: 10\.\d+\.\d+\.0\/24 \(squash root-anonymous\)$/)
    expect(fact(cache, 'Quota')).toBe('unlimited')
  })

  it('links an auto scaling group to its LAN and the servers it created', () => {
    const g = named(m, 'shop-web-scale', 'autoscaling')
    expect(m.nodes.get(g.parentId!)!.name).toBe('fra-prod-shop')
    expect(out(m, g, 'connection')).toEqual(['web'])
    expect(out(m, g, 'manages').sort()).toEqual(['shop-web-11', 'shop-web-12'])
  })

  it('points DNS records at the resources with their IPs, and finds those resources by name', () => {
    expect(out(m, named(m, 'vpn.corp.example.net', 'dnsrecord'), 'resolves-to')).toEqual(['fra-core-vpn-01'])
    expect(out(m, named(m, 'api.corp.example.net', 'dnsrecord'), 'resolves-to')).toEqual(['fra-core-nlb'])
    expect(out(m, named(m, 'shop.example.com', 'dnsrecord'), 'resolves-to')).toEqual(['shop-alb'])
    // A name pointing at a name: the records of it, or the service answering there.
    expect(out(m, named(m, 'www.shop.example.com', 'dnsrecord'), 'resolves-to')).toEqual(['shop.example.com']) // its A record, not MX or TXT
    expect(out(m, named(m, 'registry.corp.example.net', 'dnsrecord'), 'resolves-to')).toEqual(['shopregistry'])
    expect(out(m, named(m, 'static.shop.example.com', 'dnsrecord'), 'resolves-to')).toEqual(['static.shop.example.com'])
    // Reverse records too.
    const ptr = [...m.nodes.values()].filter((n) => n.subtype === 'PTR')
    expect(ptr.map((n) => out(m, n, 'resolves-to')[0]).sort()).toEqual(['fra-core-nlb', 'fra-core-vpn-01'])
    expect(query(m, 'vpn.corp.example.net')).toContain('fra-core-vpn-01')
    expect(named(m, 'shop.example.com', 'dnszone').subtype).toBeUndefined()
    expect(named(m, 'legacy.example.org', 'dnszone').subtype).toBe('secondary')
  })

  it('marks records that point at nothing in the contract', () => {
    expect(query(m, 'is:dangling')).toEqual(['old-portal.corp.example.net'])
    // An outside mail server is not the contract's business.
    expect(named(m, 'shop.example.com', 'dnsrecord').flags).toBeUndefined()
  })

  it('judges certificates by the snapshot’s date, and links who uses them', () => {
    expect(query(m, 'is:expiring').sort()).toEqual(['corp-old-portal', 'static-2025'])
    expect(query(m, 'is:expired')).toEqual(['static-2025'])
    expect(fact(named(m, 'corp-old-portal'), 'Expires')).toBe('12 days after the snapshot')
    expect(named(m, 'static-2025').state).toBe('EXPIRED')
    const shopCert = named(m, 'shop-example-com')
    expect((m.edgesByNode.get(shopCert.id) ?? []).map((e) => m.nodes.get(e.from)!.name)).toEqual(['shop-alb'])
    // The ACME order and the certificate it issued share the name.
    const auto = [...m.nodes.values()].find((n) => n.subtype === 'auto-certificate')!
    expect(fact(auto, 'Current certificate')).toBe('static-shop-auto')
    expect(named(m, 'static-shop-auto').subtype).toBe('renewed automatically')
  })

  it('links a CDN distribution to its certificate and origins', () => {
    const cdn = named(m, 'static.shop.example.com', 'cdn')
    expect(out(m, cdn, 'uses-certificate')).toEqual(['static-shop-auto'])
    expect(out(m, cdn, 'upstream').sort()).toEqual(['shop-alb', 'shop.example.com'])
    expect(cdn.ips).toEqual(['198.51.100.240', '2001:db8:cd::1'])
  })

  it('lists registries with their repositories, pipelines, backup units and snapshots', () => {
    const r = named(m, 'shopregistry', 'registry')
    expect(fact(r, 'Repositories (3)')).toContain('shop/web (12 artifacts')
    expect(query(m, 'tools/gitlab-runner')).toEqual(['shopregistry'])
    expect(named(m, 'prod-logs', 'pipeline').subtype).toBe('Logging')
    expect(named(m, 'prod-metrics', 'pipeline').subtype).toBe('Monitoring')
    expect(fact(named(m, 'backup-erp', 'backupunit'), 'Email')).toBe('backup-team@example.com')
    expect(named(m, 'erp-db-01-before-upgrade', 'snapshot').location).toBe('de/txl')
    // No secret field ever turns into a fact.
    for (const n of m.nodes.values()) for (const f of n.facts) expect(f.value).not.toMatch(/BEGIN CERTIFICATE|password/i)
  })
})
