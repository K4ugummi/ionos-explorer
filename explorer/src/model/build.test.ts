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
    expect(byKind(m, 'server')).toHaveLength(68)
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
    expect(kinds).toEqual(new Set(['nic', 'natgateway', 'nlb', 'alb']))
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

  it('reports partial visibility', () => {
    expect(m.coverageIssues.map((c) => `${c.endpoint} ${c.status}`).sort()).toEqual([
      '/um/groups forbidden',
      '/um/users forbidden',
    ])
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
})

describe('matchEndpoint', () => {
  it('extracts path parameters', () => {
    expect(matchEndpoint('/datacenters/{datacenterId}/servers', '/datacenters/abc/servers')).toEqual({ datacenterId: 'abc' })
    expect(matchEndpoint('/datacenters/{datacenterId}/servers', '/datacenters/abc/lans')).toBeNull()
  })
})
