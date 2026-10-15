import { readFileSync } from 'node:fs'
import ELK from 'elkjs/lib/elk.bundled.js'
import { describe, expect, it } from 'vitest'
import { applyAnnotations, parse } from '../annotations/annotations'
import { findPaths } from '../model/paths'
import type { Model } from '../model/types'
import { fixtureModel } from '../test/fixture'
import { focusDiagram, pathDiagram } from './build'
import { layoutDiagram } from './layout'
import type { Diagram } from './types'

const demoLinks = parse(readFileSync(new URL('../../../fixtures/demo-annotations.json', import.meta.url), 'utf8')).annotations
const id = (m: Model, name: string, kind?: string) =>
  [...m.nodes.values()].find((n) => n.name === name && (kind ? n.kind === kind : n.kind !== 'datacenter'))!.id
const titles = (d: Diagram, f: (n: Diagram['nodes'][number]) => boolean) => d.nodes.filter(f).map((n) => n.data.title)
const parentTitle = (d: Diagram, nodeId: string) => d.nodes.find((n) => n.id === d.nodes.find((x) => x.id === nodeId)!.parent)?.data.title

/** Every edge joins two boxes, ids are unique, parents exist, and every anchor points at a box or a line. */
function sound(d: Diagram) {
  const ids = new Set(d.nodes.map((n) => n.id))
  expect(ids.size).toBe(d.nodes.length)
  expect(new Set(d.edges.map((e) => e.id)).size).toBe(d.edges.length)
  for (const n of d.nodes) if (n.parent) expect(ids.has(n.parent)).toBe(true)
  for (const e of d.edges) expect([ids.has(e.source), ids.has(e.target)]).toEqual([true, true])
  for (const a of d.anchors.values()) expect(ids.has(a) || d.edges.some((e) => e.id === a)).toBe(true)
}

describe('focus diagram', async () => {
  const m = applyAnnotations(await fixtureModel(), demoLinks).model
  const fw = id(m, 'fra-core-fw-01')

  it('shows a firewall with its LANs, their members and the Cross Connect peers', () => {
    const d = focusDiagram(m, [fw])
    sound(d)
    expect(d.key).toBe(`focus:${fw}:2`)
    expect(titles(d, (n) => n.type === 'group' && !n.parent)).toEqual(['fra-prod-core'])
    const core = `focus:${id(m, 'fra-prod-core', 'datacenter')}`
    expect(titles(d, (n) => n.type === 'lan' && n.parent === core)).toEqual(['app', 'db', 'internet', 'mgmt', 'transit-fra'])
    // Members in their server groups, like the datacenter view; the firewall is the marked one.
    expect(titles(d, (n) => n.type === 'group' && n.parent === core)).toEqual([
      'fra-core-api',
      'fra-core-db',
      'fra-core-fw',
      'fra-core-web',
    ])
    expect(titles(d, (n) => !!n.data.focus)).toEqual(['fra-core-fw-01'])
    expect(parentTitle(d, fw)).toBe('fra-core-fw')
    // Cross Connects between the groups, the datacenters behind them as peers.
    expect(titles(d, (n) => n.type === 'hub')).toEqual(['fra-backbone', 'fra-mgmt'])
    expect(d.nodes.filter((n) => n.type === 'hub').every((n) => !n.parent)).toBe(true)
    expect(titles(d, (n) => n.type === 'peer')).toEqual(['fra-prod-data', 'fra-prod-shop', 'fra-mgmt'])
    const transit = d.nodes.find((n) => n.type === 'lan' && n.data.title === 'transit-fra')!
    expect(d.edges.some((e) => e.source === transit.id && e.target === `cc:${id(m, 'fra-backbone')}`)).toBe(true)
    // Each datacenter has its own internet box.
    expect(d.nodes.filter((n) => n.type === 'internet').map((n) => n.id)).toEqual([`internet:${id(m, 'fra-prod-core', 'datacenter')}`])
  })

  it('keeps LANs as boxes when what else is on them is out of reach', () => {
    // One hop: only the firewall is on its LANs here, but they are no stubs.
    const d = focusDiagram(m, [fw], { hops: 1 })
    sound(d)
    expect(titles(d, (n) => n.type === 'lan')).toEqual(['app', 'db', 'internet', 'mgmt', 'transit-fra'])
    expect(d.nodes.find((n) => n.id === fw)!.data.only).toBeUndefined()
    // Three hops reach the hub's partner LANs, which nothing else uses: they fold into it as in the datacenter view.
    const three = focusDiagram(m, [fw], { hops: 3 })
    expect(three.nodes.find((n) => n.data.title === 'fra-core-hub-01')!.data.only?.lans).toEqual(['partner-a', 'partner-b'])
  })

  it('reaches the datacenters behind Cross Connects with more hops, the focus first', () => {
    const d = focusDiagram(m, [fw], { hops: 3 })
    sound(d)
    expect(titles(d, (n) => n.type === 'group' && !n.parent)).toEqual([
      'fra-prod-core',
      'fra-mgmt',
      'fra-prod-data',
      'fra-prod-shop',
      'txl-prod-core',
    ])
    // From the focus outwards: its datacenter, the Cross Connects, then the datacenters behind them.
    const at = (f: (n: Diagram['nodes'][number]) => boolean) => d.nodes.findIndex(f)
    expect(at((n) => n.type === 'hub')).toBeGreaterThan(at((n) => n.data.title === 'fra-prod-core'))
    expect(at((n) => n.type === 'hub')).toBeLessThan(at((n) => n.data.title === 'fra-mgmt' && n.type === 'group'))
    // Their LANs on the Cross Connect are boxes now, so no peer stands for them.
    expect(titles(d, (n) => n.type === 'peer')).toEqual([])
    const data = d.nodes.find((n) => n.data.title === 'fra-prod-data')!.id
    const lan = d.nodes.find((n) => n.parent === data && n.type === 'lan')!
    expect(d.edges.some((e) => e.source === lan.id && e.target === `cc:${id(m, 'fra-backbone')}`)).toBe(true)
  })

  it('collapses large groups and opens them when asked', () => {
    const pcc = id(m, 'fra-backbone')
    const d = focusDiagram(m, [pcc])
    sound(d)
    expect(titles(d, (n) => !!n.data.focus)).toEqual(['fra-backbone'])
    const shop = d.nodes.find((n) => n.data.title === 'shop-web')!
    expect(d.nodes.filter((n) => n.parent === shop.id).map((n) => n.type)).toEqual([...Array(6).fill('member'), 'more'])
    const open = focusDiagram(m, [pcc], { expanded: new Set([shop.id]) })
    expect(open.nodes.filter((n) => n.parent === shop.id)).toHaveLength(12)
  })

  it('honours the layers', () => {
    const lb = focusDiagram(m, [fw], { hidden: new Set(['lb']) })
    sound(lb)
    expect(titles(lb, (n) => n.data.kind === 'nlb')).toEqual([])
    expect(titles(focusDiagram(m, [fw]), (n) => n.data.kind === 'nlb')).toEqual(['fra-core-nlb'])
    expect(titles(focusDiagram(m, [fw], { hidden: new Set(['peers']) }), (n) => n.type === 'peer')).toEqual([])
  })

  it('draws tunnels and manual links in reach, with the endpoints outside the contract', () => {
    const site = id(m, 'Head office')
    const d = focusDiagram(m, [site])
    sound(d)
    expect(titles(d, (n) => n.type === 'external')).toEqual(['Head office'])
    expect(d.nodes.find((n) => n.id === site)!.data.focus).toBe(true)
    const lines = d.edges.filter((e) => e.source === site || e.target === site).map((e) => [e.kind, e.label])
    expect(lines).toEqual(
      expect.arrayContaining([
        ['tunnel', 'hq-office'],
        ['manual', 'IPsec backup'],
      ]),
    )
    expect(d.anchors.get(id(m, 'hq-office'))).toBe(`tun:${id(m, 'hq-office')}`)
    expect(titles(focusDiagram(m, [site], { hidden: new Set(['links']) }), (n) => n.type === 'external')).toEqual([])
  })

  it('shows two neighbourhoods side by side when a path has no route', () => {
    const raw = { ...m, edges: m.edges.filter((e) => e.kind !== 'manual' && e.kind !== 'tunnel') }
    const [proxy, api] = [id(m, 'lhr-proxy-01'), id(m, 'fra-core-api-01')]
    const d = focusDiagram(raw, [proxy, api])
    sound(d)
    expect(titles(d, (n) => n.type === 'group' && !n.parent)).toEqual(['lhr-prod-edge', 'fra-prod-core'])
    expect(titles(d, (n) => !!n.data.focus)).toEqual(['lhr-proxy-01', 'fra-core-api-01'])
  })

  it('is laid out with every line routed and packed server groups', async () => {
    const elk = new ELK()
    const layout = await layoutDiagram(focusDiagram(m, [id(m, 'fra-backbone')]), elk)
    expect(layout.edges.filter((e) => !e.onDemand && !e.points).map((e) => e.id)).toEqual([])
    // shop-web keeps its grid (rectpacking) inside the linked layout: more than one row.
    const shop = layout.nodes.find((n) => n.data.title === 'shop-web')!
    expect(new Set(layout.nodes.filter((n) => n.parent === shop.id).map((n) => n.y)).size).toBeGreaterThan(1)
    const peers = await layoutDiagram(focusDiagram(m, [fw]), elk)
    expect(peers.edges.filter((e) => e.kind === 'peer').every((e) => !!e.points)).toBe(true)
  })
})

describe('path diagram', async () => {
  const m = applyAnnotations(await fixtureModel(), demoLinks).model
  const [web, pg] = [id(m, 'fra-core-web-01'), id(m, 'pg-orders-prod')]
  const paths = findPaths(m, web, pg)

  it('draws the paths start to end, grouped by datacenter, with the alternatives', () => {
    const d = pathDiagram(m, paths)
    sound(d)
    expect(d.directed).toBe(true)
    expect(d.key).toBe(`path:${web},${pg}:right`)
    expect(d.rootLayout['elk.direction']).toBe('RIGHT')
    expect(titles(d, (n) => n.type !== 'group')).toEqual([
      'fra-core-web-01',
      'app',
      'fra-core-fw-01',
      'fra-core-fw-02',
      'fra-core-hub-01',
      'transit-fra',
      'fra-backbone',
      'transit-fra',
      'data-etl-01',
      'data-etl-02',
      'db',
      'pg-orders-prod',
      'data-sync',
      'fra-data-sync',
      'data-sync',
    ])
    expect(titles(d, (n) => !!n.data.focus)).toEqual(['fra-core-web-01', 'pg-orders-prod'])
    expect(titles(d, (n) => n.type === 'group')).toEqual(['fra-prod-core', 'fra-prod-data'])
    expect(d.nodes.filter((n) => n.type === 'hub').every((n) => !n.parent)).toBe(true)
    expect(parentTitle(d, pg)).toBe('fra-prod-data')
    const types = new Map(d.nodes.map((n) => [n.data.title, n.type]))
    expect([types.get('app'), types.get('fra-backbone'), types.get('fra-core-fw-01')]).toEqual(['lan', 'hub', 'resource'])
    // Lines run the way the path goes; a Cross Connect line is one.
    expect(d.edges[0]).toMatchObject({ source: web, kind: 'lan' })
    expect(d.edges.filter((e) => e.kind === 'cross-connect')).toHaveLength(4)
  })

  it('turns top to bottom on a tall canvas, and routes every line', async () => {
    const down = pathDiagram(m, paths, { down: true })
    expect(down.key).toBe(`path:${web},${pg}:down`)
    expect(down.linkedLayout?.['elk.direction']).toBe('DOWN')
    const layout = await layoutDiagram(down, new ELK())
    expect(layout.edges.filter((e) => !e.points)).toEqual([])
    const y = (title: string) => layout.nodes.find((n) => n.data.title === title)!
    expect(y('fra-prod-core').y).toBeLessThan(y('fra-prod-data').y)
  })

  it('draws tunnels and manual links of a path as such', () => {
    const [txl, fra] = [id(m, 'txl-core-vpn-01'), id(m, 'fra-core-vpn-01')]
    const d = pathDiagram(m, findPaths(m, txl, fra))
    sound(d)
    expect(d.edges.find((e) => e.kind === 'manual')).toMatchObject({ source: txl, target: fra, label: 'IPsec (in the VMs)' })
    const tunnel = d.edges.find((e) => e.kind === 'tunnel')!
    expect(tunnel.label).toBe('txl-core')
    expect(d.anchors.get(id(m, 'txl-core'))).toBe(tunnel.id)
  })
})
