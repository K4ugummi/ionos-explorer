import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyAnnotations, parse } from '../annotations/annotations'
import { fixtureModel } from '../test/fixture'
import { describePath, findPaths, neighbourhood, networkGraph, networkNode, PLAIN_SERVER_COST, type Path } from './paths'
import type { Model } from './types'

const demoLinks = parse(readFileSync(new URL('../../../fixtures/demo-annotations.json', import.meta.url), 'utf8')).annotations

/** By name; the datacenter and the Cross Connect called fra-mgmt are told apart by kind. */
const id = (m: Model, name: string, kind?: string) =>
  [...m.nodes.values()].find((n) => n.name === name && (kind ? n.kind === kind : n.kind !== 'datacenter'))!.id
const names = (m: Model, p: Path) => p.nodes.map((x) => m.nodes.get(x)!.name)

/** Every path is a walk through the graph, no node twice, and has no shortcut between its inner nodes. */
function valid(m: Model, p: Path) {
  const g = networkGraph(m)
  expect(new Set(p.nodes).size).toBe(p.nodes.length)
  p.edges.forEach((e, i) => expect(e.to).toBe(p.nodes[i + 1]))
  p.nodes.forEach((x, i) => {
    for (const e of g.get(x)!) {
      const j = p.nodes.indexOf(e.to)
      if (j > i + 1) expect([i, j]).toEqual([0, p.nodes.length - 1])
    }
  })
}

describe('network graph', async () => {
  const m = await fixtureModel()
  const g = networkGraph(m)

  it('leaves NICs and volumes out and is undirected', () => {
    for (const x of g.keys()) expect(['nic', 'volume', 'image', 'datacenter']).not.toContain(m.nodes.get(x)!.kind)
    for (const [x, list] of g) for (const e of list) expect(g.get(e.to)!.some((b) => b.to === x && b.kind === e.kind)).toBe(true)
  })

  it('draws VPN tunnels from the gateway and ALB targets past the target group', () => {
    const gw = g.get(id(m, 'vpngw-mgmt'))!
    expect(gw.filter((e) => e.kind === 'tunnel').map((e) => m.nodes.get(e.to)!.name)).toEqual(['192.0.2.10', 'txl-core-vpn-01'])
    expect(gw.find((e) => e.kind === 'tunnel' && e.label === 'txl-core')).toBeDefined()
    expect(g.get(id(m, 'shop-alb'))!.filter((e) => e.kind === 'target')).toHaveLength(12)
  })

  it('maps NICs, volumes and tunnels to the resource that stands for them', () => {
    const fw = m.nodes.get(id(m, 'fra-core-fw-01'))!
    const nic = (m.children.get(fw.id) ?? []).find((c) => m.nodes.get(c)!.kind === 'nic')!
    expect(networkNode(m, nic)).toBe(fw.id)
    expect(networkNode(m, id(m, 'fra-core-fw-01-boot'))).toBe(fw.id)
    expect(networkNode(m, id(m, 'txl-core'))).toBe(id(m, 'vpngw-mgmt'))
    expect(networkNode(m, id(m, 'fra-prod-core', 'datacenter'))).toBeUndefined()
    expect(networkNode(m, 'nope')).toBeUndefined()
  })
})

describe('neighbourhood', async () => {
  const m = await fixtureModel()
  const fw = id(m, 'fra-core-fw-01')

  it('counts every node on the way as a hop, across datacenters', () => {
    const one = neighbourhood(m, fw, 1)
    expect([...one.keys()].map((x) => m.nodes.get(x)!.name).sort()).toEqual([
      'app',
      'db',
      'fra-core-fw-01',
      'internet',
      'mgmt',
      'transit-fra',
    ])
    const two = neighbourhood(m, fw)
    expect(two.size).toBe(22)
    expect(two.get(id(m, 'fra-core-web-01'))).toBe(2)
    expect(two.get(id(m, 'fra-backbone'))).toBe(2)
    expect(two.get(id(m, 'fra-mgmt', 'pcc'))).toBe(2)
    // The LANs behind the Cross Connects are one more hop away, in other datacenters.
    const three = neighbourhood(m, fw, 3)
    const far = [...three].filter(([, d]) => d === 3).map(([x]) => m.nodes.get(x)!)
    expect(new Set(far.filter((n) => n.kind === 'lan').map((n) => m.nodes.get(n.dcId!)!.name))).toEqual(
      new Set(['fra-mgmt', 'fra-prod-core', 'fra-prod-data', 'fra-prod-shop']),
    )
    expect(three.size).toBe(28)
  })

  it('starts from the server of a NIC, and is empty for what is not in the network', () => {
    const nic = (m.children.get(fw) ?? []).find((c) => m.nodes.get(c)!.kind === 'nic')!
    expect(neighbourhood(m, nic, 1).size).toBe(6)
    expect(neighbourhood(m, id(m, 'fra-prod-core', 'datacenter')).size).toBe(0)
  })
})

describe('paths', async () => {
  const raw = await fixtureModel()
  const m = applyAnnotations(raw, demoLinks).model

  it('leads a web server in fra-prod-core to the database in fra-prod-data through a Cross Connect', () => {
    const paths = findPaths(m, id(m, 'fra-core-web-01'), id(m, 'pg-orders-prod'))
    expect(paths.length).toBeGreaterThan(0)
    for (const p of paths) {
      valid(m, p)
      expect(p.nodes.some((x) => m.nodes.get(x)!.kind === 'pcc')).toBe(true)
    }
    expect(names(m, paths[0])).toEqual([
      'fra-core-web-01',
      'app',
      'fra-core-fw-01',
      'transit-fra',
      'fra-backbone',
      'transit-fra',
      'data-etl-01',
      'db',
      'pg-orders-prod',
    ])
    // The second firewall and the hub join the same LANs: one route, not three.
    expect(paths[0].alternatives[2].map((x) => m.nodes.get(x)!.name)).toEqual(['fra-core-fw-02', 'fra-core-hub-01'])
    expect(paths[0].alternatives[6].map((x) => m.nodes.get(x)!.name)).toEqual(['data-etl-02'])
    // The ETL server is no known appliance: the route holds only if it forwards.
    expect(paths[0].plain.map((x) => m.nodes.get(x)!.name)).toEqual(['data-etl-01'])
    expect(names(m, paths[1])).toContain('fra-data-sync')
    expect(describePath(m, paths[0])).toEqual([
      'member of LAN app',
      'routed by fra-core-fw-01 (likely firewall or VPN gateway), or fra-core-fw-02, fra-core-hub-01',
      'member of LAN transit-fra',
      'Cross Connect fra-backbone to fra-prod-data',
      'into LAN transit-fra in fra-prod-data',
      'through data-etl-01 (in both LANs; only if it forwards), or data-etl-02',
      'member of LAN db',
      'to pg-orders-prod (10.157.166.13/24)',
    ])
  })

  it('routes through appliances before other servers in both LANs', () => {
    const [first] = findPaths(m, id(m, 'fra-core-web-01'), id(m, 'fra-core-db-01'))
    expect(names(m, first)).toEqual(['fra-core-web-01', 'app', 'fra-core-fw-01', 'db', 'fra-core-db-01'])
    expect(first.plain).toEqual([])
    // The API servers sit in both LANs too, but are no appliances: not an alternative.
    expect(first.alternatives[2].map((x) => m.nodes.get(x)!.name)).toEqual(['fra-core-fw-02', 'fra-core-hub-01'])
    expect(PLAIN_SERVER_COST).toBeGreaterThan(100)
  })

  it('reaches fra-core-vpn-01 from txl-core-vpn-01 only through the manual link or the managed VPN tunnel', () => {
    const [a, b] = [id(m, 'txl-core-vpn-01'), id(m, 'fra-core-vpn-01')]
    const linked = findPaths(m, a, b)
    expect(names(m, linked[0])).toEqual(['txl-core-vpn-01', 'fra-core-vpn-01'])
    expect(describePath(m, linked[0])).toEqual(['manual link "IPsec (in the VMs)" to fra-core-vpn-01'])
    for (const p of linked.slice(1)) expect(p.edges[0].kind).toBe('tunnel')

    // Without the demo links, only the tunnel of the managed VPN gateway leads there.
    const tunnel = findPaths(raw, a, b)
    expect(tunnel.length).toBeGreaterThan(0)
    for (const p of tunnel) {
      valid(raw, p)
      expect(p.edges[0].kind).toBe('tunnel')
      expect(names(raw, p)[1]).toBe('vpngw-mgmt')
    }
    expect(describePath(raw, tunnel[0])[0]).toBe('VPN tunnel txl-core to vpngw-mgmt')

    // Neither: no way at all.
    const none = { ...raw, edges: raw.edges.filter((e) => e.kind !== 'tunnel') }
    expect(findPaths(none, a, b)).toEqual([])
  })

  it('takes the London proxies to Frankfurt through the head office, and nowhere without the links', () => {
    const [proxy, api] = [id(m, 'lhr-proxy-01'), id(m, 'fra-core-api-01')]
    const paths = findPaths(m, proxy, api)
    expect(paths).toHaveLength(3)
    for (const p of paths) {
      valid(m, p)
      expect(names(m, p)).toContain('Head office')
    }
    expect(describePath(m, paths[0]).slice(0, 4)).toEqual([
      'member of LAN internet, or lhr-link',
      'routed by lhr-edge-gw-01 (Cisco ASAv)',
      'manual link "IPsec backup" to Head office',
      'VPN tunnel hq-office to vpngw-mgmt',
    ])
    expect(findPaths(raw, id(raw, 'lhr-proxy-01'), id(raw, 'fra-core-api-01'))).toEqual([])
  })

  it('passes a load balancer only from its listener LAN to a target', () => {
    const [vpn, web] = [id(m, 'fra-core-vpn-01'), id(m, 'fra-core-web-01')]
    expect(names(m, findPaths(m, vpn, web)[0])).toEqual(['fra-core-vpn-01', 'internet', 'fra-core-nlb', 'fra-core-web-01'])
    for (const p of findPaths(m, web, vpn)) expect(names(m, p)).not.toContain('fra-core-nlb')
  })

  it('finds nothing between a resource and itself, or the NIC of the same server', () => {
    const fw = id(m, 'fra-core-fw-01')
    const nic = (m.children.get(fw) ?? []).find((c) => m.nodes.get(c)!.kind === 'nic')!
    expect(findPaths(m, fw, fw)).toEqual([])
    expect(findPaths(m, fw, nic)).toEqual([])
    expect(findPaths(m, fw, 'nope')).toEqual([])
  })

  it('stays small and quick between every pair of servers in the demo', () => {
    const servers = [...m.nodes.values()].filter((n) => n.kind === 'server').map((n) => n.id)
    const start = performance.now()
    let routes = 0
    for (const a of servers.slice(0, 8)) {
      for (const b of servers) {
        if (a === b) continue
        const paths = findPaths(m, a, b)
        expect(paths.length).toBeLessThanOrEqual(3)
        paths.forEach((p) => valid(m, p))
        if (paths.length) routes++
      }
    }
    expect(routes).toBeGreaterThan(300)
    expect(performance.now() - start).toBeLessThan(10000)
  }, 30000)
})
