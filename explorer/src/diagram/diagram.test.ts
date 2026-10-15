import ELK from 'elkjs/lib/elk.bundled.js'
import { describe, expect, it } from 'vitest'
import type { Model } from '../model/types'
import { fixtureModel } from '../test/fixture'
import { contractDiagram, datacenterDiagram, diagramFor, stem } from './build'
import { toFlow } from './flow'
import { midpoint, roundedPath } from './geometry'
import { absolutePositions, layoutDiagram } from './layout'
import type { Diagram } from './types'

const named = (m: Model, name: string) => [...m.nodes.values()].find((n) => n.name === name)!
const node = (d: Diagram, id: string) => d.nodes.find((n) => n.id === id)!
const titled = (d: Diagram, title: string) => d.nodes.find((n) => n.data.title === title)!
const edgesOf = (d: Diagram, id: string) => d.edges.filter((e) => e.source === id || e.target === id)

describe('contract diagram', async () => {
  const m = await fixtureModel()
  const d = contractDiagram(m)

  it('groups all datacenters by location', () => {
    expect(d.nodes.filter((n) => n.type === 'dc')).toHaveLength(14)
    const locations = d.nodes.filter((n) => n.id.startsWith('loc:')).map((n) => n.data.title)
    expect(locations).toEqual(['de/fra', 'de/fra/2', 'de/txl', 'es/vit', 'gb/lhr'])
    expect(node(d, named(m, 'fra-prod-core').id).parent).toBe('loc:de/fra')
    expect(node(d, named(m, 'fra-prod-core').id).data.pills).toContain('12 servers')
  })

  it('draws two-peer Cross Connects as lines and others as hubs', () => {
    // A datacenter and a Cross Connect are both called fra-mgmt.
    const pcc = [...m.nodes.values()].find((n) => n.kind === 'pcc' && n.name === 'fra-mgmt')!
    const line = d.edges.find((e) => e.ref === pcc.id)!
    expect([line.label, line.kind]).toEqual(['fra-mgmt', 'cross-connect'])
    expect([line.source, line.target].map((id) => m.nodes.get(id)!.name)).toEqual(['fra-mgmt', 'fra-prod-core'])
    expect(d.anchors.get(pcc.id)).toBe(line.id)

    const backbone = named(m, 'fra-backbone')
    const hub = node(d, `cc:${backbone.id}`)
    expect(hub.type).toBe('hub')
    expect(hub.parent).toBe('loc:de/fra')
    expect(edgesOf(d, hub.id)).toHaveLength(3)

    const legacy = node(d, `cc:${named(m, 'fra-legacy-link').id}`)
    expect(node(d, legacy.parent!).data.title).toBe('No visible peers')
  })

  it('anchors resources to their datacenter card', () => {
    const web = named(m, 'fra-core-web-03')
    expect(d.anchors.get(web.id)).toBe(web.dcId)
  })
})

describe('datacenter diagram', async () => {
  const m = await fixtureModel()
  const core = named(m, 'fra-prod-core')
  const d = datacenterDiagram(m, core.id)

  it('shows the internet, LANs and resources between them', () => {
    expect(node(d, 'internet')).toBeDefined()
    expect(d.nodes.filter((n) => n.type === 'lan').map((n) => n.data.title)).toEqual(['app', 'db', 'internet', 'mgmt', 'transit-fra'])
    const inet = titled(d, 'internet')
    expect(d.edges.some((e) => e.source === 'internet' && e.target === inet.id)).toBe(true)
  })

  it('groups servers that share a name stem and LANs', () => {
    const web = titled(d, 'fra-core-web')
    expect(web.type).toBe('group')
    expect(d.nodes.filter((n) => n.parent === web.id)).toHaveLength(4)
    // One LAN link for the whole group instead of one per server.
    expect(edgesOf(d, web.id).map((e) => node(d, e.source).data.title)).toEqual(['app'])
    // The firewalls hang off the public LAN and fan out to the others.
    const fw = titled(d, 'fra-core-fw')
    const fwEdges = edgesOf(d, fw.id)
    expect(fwEdges.filter((e) => e.target === fw.id).map((e) => node(d, e.source).data.title)).toEqual(['internet'])
    expect(fwEdges).toHaveLength(5)
  })

  it('wires load balancers listener → balancer → target, targets on demand', () => {
    const nlb = named(m, 'fra-core-nlb')
    const plain = edgesOf(d, nlb.id).filter((e) => !e.onDemand)
    expect(plain.map((e) => [node(d, e.source).data.title, node(d, e.target).data.title])).toEqual([
      ['internet', 'fra-core-nlb'],
      ['fra-core-nlb', 'app'],
    ])
    expect(edgesOf(d, nlb.id).filter((e) => e.onDemand && e.kind === 'target')).toHaveLength(4)
  })

  it('leads Cross Connects to the peer datacenters', () => {
    const hub = node(d, `cc:${named(m, 'fra-backbone').id}`)
    const peers = d.edges.filter((e) => e.source === hub.id).map((e) => node(d, e.target))
    expect(peers.map((p) => [p.type, p.data.title])).toEqual([
      ['peer', 'fra-prod-data'],
      ['peer', 'fra-prod-shop'],
    ])
  })

  it('anchors NICs and volumes to their server', () => {
    const web = named(m, 'fra-core-web-03')
    const nic = (m.children.get(web.id) ?? []).find((id) => m.nodes.get(id)!.kind === 'nic')!
    expect(d.anchors.get(nic)).toBe(web.id)
    expect(d.anchors.get(named(m, 'fra-core-web-03-boot').id)).toBe(web.id)
  })

  it('handles datacenters without internet, and leftovers', () => {
    const data = datacenterDiagram(m, named(m, 'fra-prod-data').id)
    expect(data.nodes.some((n) => n.type === 'internet')).toBe(false)
    expect(titled(data, 'np-general').type).toBe('resource')
    expect(titled(data, 'pg-orders-prod').type).toBe('resource')
    const k8s = [...m.nodes.values()].find((n) => n.kind === 'k8s' && n.name === 'k8s-prod-fra')!
    expect(data.anchors.get(k8s.id)).toBe(named(m, 'np-general').id)

    const lab = datacenterDiagram(m, named(m, 'fra-lab').id)
    const orphans = titled(lab, 'Unattached volumes')
    expect(lab.nodes.filter((n) => n.parent === orphans.id).map((n) => n.data.title)).toEqual(['old-dataset'])
  })

  it('returns an empty diagram for unknown ids', () => {
    expect(datacenterDiagram(m, 'nope').nodes).toEqual([])
  })
})

describe('layout', async () => {
  const m = await fixtureModel()
  const elk = new ELK()
  const diagrams = [contractDiagram(m), ...[...m.nodes.values()].filter((n) => n.kind === 'datacenter').map((dc) => datacenterDiagram(m, dc.id))]
  const layouts = await Promise.all(diagrams.map((d) => layoutDiagram(d, elk)))

  it('places every node without overlapping its siblings', () => {
    for (const [i, l] of layouts.entries()) {
      expect(l.nodes).toHaveLength(diagrams[i].nodes.length)
      const abs = absolutePositions(l)
      const byParent = new Map<string, typeof l.nodes>()
      for (const n of l.nodes) {
        expect(Number.isFinite(n.x) && Number.isFinite(n.y) && n.width > 0 && n.height > 0, `${l.key} ${n.id}`).toBe(true)
        byParent.set(n.parent ?? '', [...(byParent.get(n.parent ?? '') ?? []), n])
        if (n.parent) {
          const [c, p] = [abs.get(n.id)!, abs.get(n.parent)!]
          expect(c.x >= p.x && c.y >= p.y && c.x + c.width <= p.x + p.width + 0.5 && c.y + c.height <= p.y + p.height + 0.5, `${n.id} inside ${n.parent}`).toBe(true)
        }
      }
      for (const siblings of byParent.values()) {
        for (const a of siblings) {
          for (const b of siblings) {
            if (a === b) continue
            const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
            expect(overlap, `${l.key}: ${a.data.title} overlaps ${b.data.title}`).toBe(false)
          }
        }
      }
    }
  })

  it('routes edges between siblings and leaves the rest to the renderer', () => {
    for (const l of layouts) {
      const parent = new Map(l.nodes.map((n) => [n.id, n.parent]))
      for (const e of l.edges) {
        const siblings = parent.get(e.source) === parent.get(e.target)
        if (siblings && !e.onDemand) expect(e.points?.length, `${l.key} ${e.id}`).toBeGreaterThanOrEqual(2)
        else expect(e.points).toBeUndefined()
      }
    }
  })

  it('puts the internet on top and public LANs above private ones', () => {
    const l = layouts[diagrams.findIndex((d) => d.key === `dc:${named(m, 'fra-prod-core').id}`)]
    const y = (title: string) => l.nodes.find((n) => n.data.title === title)!.y
    expect(y('Internet')).toBeLessThan(y('internet'))
    expect(y('internet')).toBeLessThan(y('app'))
    expect(y('internet')).toBeLessThan(y('transit-fra'))
  })

  it('is deterministic', async () => {
    const again = await layoutDiagram(diagrams[0], elk)
    expect(again).toEqual(layouts[0])
  })

  it('applies selection and search to the flow elements', () => {
    const d = diagrams.find((x) => x.key === `dc:${named(m, 'fra-prod-core').id}`)!
    const l = layouts[diagrams.indexOf(d)]
    const nlb = named(m, 'fra-core-nlb').id
    const web = named(m, 'fra-core-web-03').id
    const flow = toFlow(l, d, nlb, new Set([web]))
    const targets = flow.edges.filter((e) => e.data?.kind === 'target')
    expect(targets.every((e) => !e.hidden)).toBe(true)
    expect(flow.nodes.find((n) => n.id === nlb)!.selected).toBe(true)
    expect(flow.nodes.find((n) => n.id === web)!.data.matches).toBe(1)
    expect(flow.nodes.find((n) => n.data.node.data.title === 'db')!.data.dim).toBe(true)

    const idle = toFlow(l, d, undefined, null)
    expect(idle.edges.filter((e) => e.data?.kind === 'target').every((e) => e.hidden)).toBe(true)
    expect(idle.nodes.some((n) => n.data.dim)).toBe(false)
  })
})

describe('diagramFor', async () => {
  const m = await fixtureModel()
  const core = named(m, 'fra-prod-core').id
  const shop = named(m, 'fra-prod-shop').id

  it('follows resources to their datacenter', () => {
    expect(diagramFor(m, named(m, 'fra-core-web-03').id)).toBe(core)
    expect(diagramFor(m, named(m, 'shop-alb').id, core)).toBe(shop)
  })

  it('shows datacenters and Cross Connects in context', () => {
    expect(diagramFor(m, core, core)).toBe(core)
    expect(diagramFor(m, shop, core)).toBeUndefined()
    const backbone = named(m, 'fra-backbone').id
    expect(diagramFor(m, backbone, shop)).toBe(shop)
    expect(diagramFor(m, backbone, named(m, 'txl-dev').id)).toBeUndefined()
  })

  it('keeps the view for contract-wide resources', () => {
    const block = [...m.nodes.values()].find((n) => n.kind === 'ipblock')!
    expect(diagramFor(m, block.id, core)).toBe(core)
    expect(diagramFor(m, block.id)).toBeUndefined()
  })
})

describe('geometry', () => {
  it('rounds corners and finds the middle of a route', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 0, y: 100 },
      { x: 100, y: 100 },
    ]
    expect(roundedPath(pts)).toBe('M 0 0 L 0 92 Q 0 100 8 100 L 100 100')
    expect(midpoint(pts)).toEqual({ x: 0, y: 100 })
    expect(stem('fra-core-web-03')).toBe('fra-core-web')
    expect(stem('42')).toBe('42')
  })
})
