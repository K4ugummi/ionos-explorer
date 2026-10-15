import { describe, expect, it } from 'vitest'
import { fixtureModel } from '../test/fixture'
import { buildModel, matchEndpoint } from './build'
import type { Model, NodeKind } from './types'

const byKind = (m: Model, kind: NodeKind) => [...m.nodes.values()].filter((n) => n.kind === kind)
const byName = (m: Model, name: string) => [...m.nodes.values()].find((n) => n.name === name)!

describe('buildModel on the demo fixture', async () => {
  const m = await fixtureModel()

  it('builds the contract tree', () => {
    expect(m.nodes.get(m.rootId)?.name).toBe('Contract 31812345')
    expect(byKind(m, 'datacenter')).toHaveLength(14)
    expect(byKind(m, 'server')).toHaveLength(69)
    expect(m.warnings).toEqual([])
    for (const n of m.nodes.values()) {
      if (n.id !== m.rootId) expect(m.nodes.has(n.parentId!), `${n.kind} ${n.name}`).toBe(true)
    }
  })

  it('connects datacenters through Cross Connects', () => {
    const backbone = byName(m, 'fra-backbone')
    const peers = m.edgesByNode.get(backbone.id)!.filter((e) => e.kind === 'cross-connect')
    const dcs = peers.map((e) => m.nodes.get(m.nodes.get(e.from)!.dcId!)!.name).sort()
    expect(dcs).toEqual(['fra-prod-core', 'fra-prod-data', 'fra-prod-shop'])
    expect(m.edgesByNode.get(byName(m, 'fra-legacy-link').id)).toBeUndefined()
  })

  it('resolves load balancer targets to servers', () => {
    const nlb = byName(m, 'fra-core-nlb')
    const targets = m.edges.filter((e) => e.from === nlb.id && e.kind === 'target').map((e) => m.nodes.get(e.to)!.name)
    expect(targets.sort()).toEqual(['fra-core-web-01', 'fra-core-web-02', 'fra-core-web-03', 'fra-core-web-04'])
    const tg = byName(m, 'shop-alb-web')
    expect(m.edges.filter((e) => e.from === tg.id && e.kind === 'target')).toHaveLength(6)
  })

  it('links IP block addresses to their consumers', () => {
    const reserve = byName(m, 'ipb-de-fra-reserve')
    expect(m.edgesByNode.get(reserve.id)).toBeUndefined()
    const consumers = byKind(m, 'ipblock').flatMap((b) => m.edgesByNode.get(b.id) ?? [])
    const kinds = new Set(consumers.map((e) => m.nodes.get(e.to)!.kind))
    expect(kinds).toEqual(new Set(['nic', 'natgateway', 'nlb', 'alb', 'vpngateway']))
  })

  it('attaches labels, images and managed services', () => {
    expect(byName(m, 'fra-core-vpn-01').labels).toMatchObject({ env: 'prod', role: 'vpn' })
    const boot = byName(m, 'lhr-edge-gw-01-boot')
    const img = m.edges.find((e) => e.from === boot.id && e.kind === 'uses-image')
    expect(m.nodes.get(img!.to)!.name).toBe('asav9-20-2-15.qcow2')
    const pg = byName(m, 'pg-orders-prod')
    expect(m.nodes.get(pg.dcId!)!.name).toBe('fra-prod-data')
    expect(byName(m, 'np-general').parentId).toBe(byName(m, 'k8s-prod-fra').id)
  })

  it('reads Security Groups and who uses them', () => {
    const groups = byKind(m, 'securitygroup')
    expect(groups.map((g) => g.name).sort()).toEqual(['sg-edge-ipsec', 'sg-edge-web'])
    const web = byName(m, 'sg-edge-web')
    expect(m.nodes.get(web.parentId!)!.name).toBe('lhr-prod-edge')
    expect(web.facts.find((f) => f.label === 'Rules')?.value).toBe('TCP 443, ICMP')
    const users = m.edges.filter((e) => e.kind === 'secured-by' && e.to === web.id).map((e) => m.nodes.get(e.from)!.name)
    expect(users.sort()).toEqual(['lhr-proxy-01', 'lhr-proxy-02', 'lhr-proxy-03'])
  })

  it('reads PostgreSQL v2 clusters from the regional APIs', () => {
    const pg = byName(m, 'pg-orders-prod')
    const facts = Object.fromEntries(pg.facts.map((f) => [f.label, f.value]))
    expect(facts).toMatchObject({ PostgreSQL: '15', Instances: '3', RAM: '16 GB', Replication: 'ASYNCHRONOUS' })
    expect(pg.location).toBe('de/fra')
    const lan = m.edges.find((e) => e.from === pg.id && e.kind === 'connection')
    expect(m.nodes.get(lan!.to)!.name).toBe('db')
  })

  it('reports partial visibility', () => {
    expect(m.coverageIssues.map((c) => `${c.endpoint} ${c.status}`).sort()).toEqual(['/um/groups forbidden', '/um/users forbidden'])
  })
})

describe('buildModel robustness', () => {
  const manifest = {
    formatVersion: 1,
    createdAt: '2026-01-01T00:00:00Z',
    generator: { name: 'test', version: '0' },
    synthetic: true,
    apis: [],
    files: [],
  }

  it('keeps unknown endpoints searchable and creates placeholders for invisible references', () => {
    const files = new Map<string, unknown>([
      ['raw/cloudapi-v6/datacenters.json', { items: [{ id: 'dc1', properties: { name: 'only-dc', location: 'de/fra' } }] }],
      ['raw/cloudapi-v6/datacenters/dc1/lans.json', { items: [{ id: '1', properties: { name: 'l', pcc: 'pcc-x' } }] }],
      ['raw/dns-v1/zones.json', { items: [{ id: 'z1', properties: { zoneName: 'example.com', name: 'my-zone' } }] }],
      ['raw/cloudapi-v6/weird.json', 'not a collection'],
    ])
    const cov = (api: string, endpoint: string, path: string, file: string) => ({ api, endpoint, path, file, status: 'ok' as const })
    const m = buildModel({
      manifest: {
        ...manifest,
        coverage: [
          cov('cloudapi-v6', '/datacenters', '/datacenters', 'raw/cloudapi-v6/datacenters.json'),
          cov('cloudapi-v6', '/datacenters/{datacenterId}/lans', '/datacenters/dc1/lans', 'raw/cloudapi-v6/datacenters/dc1/lans.json'),
          cov('dns-v1', '/zones', '/zones', 'raw/dns-v1/zones.json'),
          cov('cloudapi-v6', '/weird', '/weird', 'raw/cloudapi-v6/weird.json'),
          { api: 'cloudapi-v6', endpoint: '/pccs', path: '/pccs', status: 'forbidden' },
        ],
      },
      files,
    })
    expect(byName(m, 'my-zone').kind).toBe('other')
    expect(m.nodes.get('pcc-x')?.placeholder).toBe(true)
    expect(m.edges.some((e) => e.kind === 'cross-connect' && e.to === 'pcc-x')).toBe(true)
    expect(m.coverageIssues).toHaveLength(1)
  })

  it('still reads PostgreSQL v1 clusters from older snapshots', () => {
    const v1 = {
      id: 'pg1',
      properties: {
        displayName: 'old-pg',
        postgresVersion: '14',
        instances: 2,
        ram: 4096,
        location: 'de/txl',
        connections: [{ datacenterId: 'dc1', lanId: '1', cidr: '10.0.0.5/24' }],
      },
    }
    const m = buildModel({
      manifest: {
        ...manifest,
        coverage: [
          { api: 'postgresql-v1', endpoint: '/clusters', path: '/clusters', file: 'raw/postgresql-v1/clusters.json', status: 'ok' },
        ],
      },
      files: new Map([['raw/postgresql-v1/clusters.json', { items: [v1] }]]),
    })
    const pg = byName(m, 'old-pg')
    expect(pg.facts.find((f) => f.label === 'RAM')?.value).toBe('4 GB')
    expect(pg.ips).toEqual(['10.0.0.5'])
  })

  it('names users and admits firewall rules it cannot see', () => {
    const m = buildModel({
      manifest: {
        ...manifest,
        coverage: [
          { api: 'cloudapi-v6', endpoint: '/um/users', path: '/um/users', file: 'raw/cloudapi-v6/um/users.json', status: 'ok' },
          {
            api: 'cloudapi-v6',
            endpoint: '/datacenters/{datacenterId}/servers',
            path: '/datacenters/dc1/servers',
            file: 'raw/cloudapi-v6/datacenters/dc1/servers.json',
            status: 'ok',
          },
        ],
      },
      files: new Map<string, unknown>([
        [
          'raw/cloudapi-v6/um/users.json',
          { items: [{ id: 'u1', properties: { firstname: 'Ada', lastname: 'Example', email: 'a@example.com' } }] },
        ],
        [
          'raw/cloudapi-v6/datacenters/dc1/servers.json',
          {
            items: [
              {
                id: 's1',
                properties: { name: 'srv' },
                entities: {
                  nics: { items: [{ id: 'n1', properties: { lan: 1 }, entities: { firewallrules: { items: [{ id: 'r1' }] } } }] },
                },
              },
            ],
          },
        ],
      ]),
    })
    expect(m.nodes.get('u1')?.name).toBe('Ada Example')
    expect(m.nodes.get('n1')?.facts.find((f) => f.label === 'Firewall rules')?.value).toBe('1 (contents not in this snapshot)')
  })
})

describe('matchEndpoint', () => {
  it('extracts path parameters', () => {
    expect(matchEndpoint('/datacenters/{datacenterId}/servers', '/datacenters/abc/servers')).toEqual({ datacenterId: 'abc' })
    expect(matchEndpoint('/datacenters/{datacenterId}/servers', '/datacenters/abc/lans')).toBeNull()
  })
})
