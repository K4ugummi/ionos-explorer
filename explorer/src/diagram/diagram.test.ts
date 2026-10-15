import ELK from 'elkjs/lib/elk.bundled.js'
import { describe, expect, it } from 'vitest'
import type { GraphEdge, GraphNode, Model } from '../model/types'
import { fixtureModel } from '../test/fixture'
import { contractDiagram, datacenterDiagram, diagramFor, GROUP_LIMIT, GROUP_PREVIEW, preview, ROUTER_LANS, stem } from './build'
import { toFlow } from './flow'
import { midpoint, roundedPath } from './geometry'
import { absolutePositions, layoutDiagram, layoutSignature } from './layout'
import type { Diagram, Layout } from './types'
import { addLink, addSite, applyAnnotations, EMPTY, siteNodeId } from '../annotations/annotations'

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
    expect(node(d, named(m, 'fra-prod-core').id).data.pills).toContain('13 servers')
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
    expect(node(d, legacy.parent!).data.title).toBe('Unused Cross Connects')
    expect(legacy.data.subtitle).toBe('no LAN connected')
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
  const diagrams = [
    contractDiagram(m),
    ...[...m.nodes.values()].filter((n) => n.kind === 'datacenter').map((dc) => datacenterDiagram(m, dc.id)),
  ]
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
          expect(
            c.x >= p.x && c.y >= p.y && c.x + c.width <= p.x + p.width + 0.5 && c.y + c.height <= p.y + p.height + 0.5,
            `${n.id} inside ${n.parent}`,
          ).toBe(true)
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
        // The contract view routes lines between locations too (linkedLayout).
        const routed = (l.key === 'contract' || parent.get(e.source) === parent.get(e.target)) && !e.onDemand
        if (routed) expect(e.points?.length, `${l.key} ${e.id}`).toBeGreaterThanOrEqual(2)
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

    // Lines at the selection keep their label when zoomed out (detail by zoom); no others.
    expect(flow.edges.filter((e) => e.data!.hl).every((e) => e.source === nlb || e.target === nlb)).toBe(true)
    expect(flow.edges.some((e) => e.data!.hl)).toBe(true)
    expect(idle.edges.some((e) => e.data!.hl)).toBe(false)
  })
})

describe('routers: servers in many LANs', async () => {
  const m = await fixtureModel()
  const d = datacenterDiagram(m, named(m, 'fra-prod-core').id)
  const lanEdges = (id: string) => edgesOf(d, id).filter((e) => e.kind === 'lan')
  const ends = (list: typeof d.edges) => list.map((e) => `${node(d, e.source).data.title} → ${node(d, e.target).data.title}`)
  const hub = named(m, 'fra-core-hub-01').id
  const fw = titled(d, 'fra-core-fw')

  it('draws a server in 4 or more LANs as a router box', () => {
    expect(ROUTER_LANS).toBe(4)
    expect(node(d, hub)).toMatchObject({
      type: 'router',
      width: 280,
      height: 72,
      data: { lans: 7, subtitle: expect.stringMatching(/^vCPU · 10\./) },
    })
    // The firewall pair keeps its group, which acts as one router.
    expect(fw).toMatchObject({ type: 'group', data: { lans: 5 } })
    expect(d.nodes.filter((n) => n.parent === fw.id).map((n) => n.type)).toEqual(['member', 'member'])
  })

  it('keeps the first LAN and LANs nothing else connects; the rest on demand', () => {
    const always = (id: string) => ends(lanEdges(id).filter((e) => !e.onDemand))
    const later = (id: string) => ends(lanEdges(id).filter((e) => e.onDemand))
    // mgmt has only the two routers: the first one (the firewalls) draws it.
    expect(always(fw.id)).toEqual(['internet → fra-core-fw', 'fra-core-fw → mgmt'])
    expect(later(fw.id)).toEqual(['fra-core-fw → app', 'fra-core-fw → db', 'fra-core-fw → transit-fra'])
    expect(always(hub)).toEqual(['app → fra-core-hub-01'])
    expect(later(hub)).toEqual(['fra-core-hub-01 → db', 'fra-core-hub-01 → transit-fra', 'fra-core-hub-01 → mgmt'])
    // Nobody else's edges are on demand, except load balancer targets.
    expect(d.edges.filter((e) => e.onDemand && e.kind !== 'target').every((e) => e.source === fw.id || e.source === hub)).toBe(true)
  })

  it('folds the LANs only the hub uses', () => {
    // partner-a and partner-b have nothing else on them: listed on the hub, no boxes.
    expect(node(d, hub).data.only).toEqual({ lans: ['partner-a', 'partner-b'], key: `lans:${hub}` })
    for (const name of ['partner-a', 'partner-b', 'data-sync']) {
      expect(d.nodes.some((n) => n.type === 'lan' && n.data.title === name)).toBe(false)
    }
    expect(d.anchors.get(named(m, 'partner-a').id)).toBe(hub)
    // data-sync leads only to a Cross Connect: the hub's line goes straight to it.
    const sync = d.edges.find((e) => e.label === 'data-sync')!
    expect([sync.kind, sync.source, node(d, sync.target).data.title, sync.onDemand]).toEqual([
      'cross-connect',
      hub,
      'fra-data-sync',
      undefined,
    ])
    const syncLan = [...m.nodes.values()].find((n) => n.name === 'data-sync' && n.dcId === named(m, 'fra-prod-core').id)!
    expect(d.anchors.get(syncLan.id)).toBe(sync.id)
    expect(edgesOf(d, sync.target).map((e) => node(d, e.target).data.title)).toContain('fra-prod-data')
  })

  it('marks LANs a router reaches only on demand', () => {
    const via = Object.fromEntries(d.nodes.filter((n) => n.type === 'lan').map((n) => [n.data.title, n.data.via]))
    expect(via).toEqual({ app: 'fra-core-fw', db: '2 routers', internet: undefined, mgmt: 'fra-core-hub-01', 'transit-fra': '2 routers' })
  })

  it('leaves a server in 3 LANs alone', () => {
    const vit = datacenterDiagram(m, named(m, 'vit-dr-core').id)
    const fw3 = named(m, 'vit-fw-01').id
    expect(node(vit, fw3).type).toBe('resource')
    expect(node(vit, fw3).data.lans).toBeUndefined()
    expect(edgesOf(vit, fw3).filter((e) => e.kind === 'lan')).toHaveLength(3)
    expect(vit.edges.some((e) => e.onDemand && e.kind === 'lan')).toBe(false)
    expect(vit.nodes.some((n) => n.data.via)).toBe(false)
  })

  it('does not lay out on-demand edges, so selecting a router keeps the layout', async () => {
    const routed = { ...d, edges: d.edges.filter((e) => !e.onDemand) }
    expect(layoutSignature(d)).toBe(layoutSignature(routed))
    const l = await layoutDiagram(d, new ELK())
    for (const e of l.edges.filter((x) => x.onDemand)) expect(e.points, e.id).toBeUndefined()

    const idle = toFlow(l, d, undefined, null)
    const shown = (f: typeof idle) => f.edges.filter((e) => !e.hidden && e.data?.kind === 'lan').map((e) => e.id)
    expect(shown(idle)).not.toContain(`${hub}->${titled(d, 'mgmt').id}`)
    // A member of the firewall group selected: all five group lines drawn and highlighted.
    const sel = toFlow(l, d, named(m, 'fra-core-fw-01').id, null)
    const fwLines = sel.edges.filter((e) => e.source === fw.id || e.target === fw.id)
    expect(fwLines.map((e) => [!!e.hidden, e.className?.includes('hl')])).toEqual(Array(5).fill([false, true]))
    // A LAN with a via marker selected: the router's line to it is drawn.
    const mgmt = toFlow(l, d, titled(d, 'mgmt').id, null)
    expect(shown(mgmt)).toContain(`${hub}->${titled(d, 'mgmt').id}`)
    expect(mgmt.nodes.find((n) => n.id === hub)!.data.related).toBe(true)
  })

  it('leads unrouted lines to a box above from its top', async () => {
    const l = await layoutDiagram(d, new ELK())
    const abs = absolutePositions(l)
    const flow = toFlow(l, d, hub, null)
    const unrouted = flow.edges.filter((e) => !e.data?.points)
    expect(unrouted.some((e) => e.sourceHandle === 'top-out')).toBe(true)
    for (const e of unrouted) {
      const [s, t] = [abs.get(e.source)!, abs.get(e.target)!]
      const up = t.y + t.height <= s.y
      expect([e.sourceHandle, e.targetHandle], e.id).toEqual(up ? ['top-out', 'bottom-in'] : ['bottom', 'top'])
    }
  })
})

interface RouterSpec {
  /** LANs with another server each. */
  shared?: number
  /** LANs with nothing but the routers. */
  stub?: number
  /** LANs with nothing but the routers and a Cross Connect to a peer datacenter. */
  transit?: number
  /** A public LAN, also with nothing else on it. */
  pub?: boolean
  routers?: string[]
}

/** One datacenter `dc` whose routers sit in all its LANs, plus a peer datacenter behind the Cross Connects. */
function routerModel({ shared = 0, stub = 0, transit = 0, pub = false, routers = ['edge-rtr'] }: RouterSpec): Model {
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const add = (p: Partial<GraphNode> & Pick<GraphNode, 'id' | 'kind' | 'name'>) =>
    nodes.set(p.id, { ips: [], macs: [], labels: {}, facts: [], terms: [], searchText: '', raw: null, ...p })
  const lan = (id: string, subtype = 'private', dc = 'dc') =>
    add({ id, kind: 'lan', name: id.replace(/(\d+)$/, '-$1'), dcId: dc, parentId: dc, subtype })
  add({ id: 'root', kind: 'contract', name: 'Contract' })
  add({ id: 'dc', kind: 'datacenter', name: 'dc', dcId: 'dc', parentId: 'root' })
  add({ id: 'peer', kind: 'datacenter', name: 'peer-dc', dcId: 'peer', parentId: 'root' })
  const mine: string[] = []
  if (pub) {
    mine.push('pub')
    lan('pub', 'public')
  }
  for (let i = 0; i < shared; i++) {
    mine.push(`s${i}`)
    lan(`s${i}`)
    add({ id: `app${i}`, kind: 'server', name: `app${i}-01`, dcId: 'dc', parentId: 'dc' })
    edges.push({ kind: 'member', from: `app${i}`, to: `s${i}` })
  }
  for (let i = 0; i < stub; i++) {
    mine.push(`x${i}`)
    lan(`x${i}`)
  }
  for (let i = 0; i < transit; i++) {
    mine.push(`t${i}`)
    lan(`t${i}`)
    lan(`p${i}`, 'private', 'peer')
    add({ id: `pcc${i}`, kind: 'pcc', name: `cc-${i}`, parentId: 'root' })
    edges.push({ kind: 'cross-connect', from: `t${i}`, to: `pcc${i}` }, { kind: 'cross-connect', from: `p${i}`, to: `pcc${i}` })
  }
  for (const r of routers) {
    add({ id: r, kind: 'server', name: r, dcId: 'dc', parentId: 'dc' })
    for (const l of mine) edges.push({ kind: 'member', from: r, to: l })
  }
  const children = new Map<string, string[]>()
  const edgesByNode = new Map<string, GraphEdge[]>()
  for (const n of nodes.values()) if (n.parentId) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n.id])
  for (const e of edges) for (const id of [e.from, e.to]) edgesByNode.set(id, [...(edgesByNode.get(id) ?? []), e])
  return { rootId: 'root', nodes, edges, children, edgesByNode, coverageIssues: [], warnings: [] } as unknown as Model
}

describe('routers in a synthetic datacenter', () => {
  const lanLines = (d: Diagram, id: string) => edgesOf(d, id).filter((e) => e.kind === 'lan')
  const has = (d: Diagram, id: string) => d.nodes.some((n) => n.id === id)
  /** Every edge ends at a box of the diagram. */
  const wired = (d: Diagram) => d.edges.every((e) => has(d, e.source) && has(d, e.target))

  it('folds stub and transit LANs of a router in 16 LANs', async () => {
    const m = routerModel({ shared: 2, stub: 10, transit: 4 })
    const d = datacenterDiagram(m, 'dc')
    const r = node(d, 'edge-rtr')
    expect(r).toMatchObject({ type: 'router', data: { lans: 16 } })
    // Stubs: no boxes, listed on the router, found through it.
    expect(r.data.only).toEqual({ lans: Array.from({ length: 10 }, (_, i) => `x-${i}`), key: 'lans:edge-rtr' })
    for (let i = 0; i < 10; i++) {
      expect(has(d, `x${i}`)).toBe(false)
      expect(d.anchors.get(`x${i}`)).toBe('edge-rtr')
    }
    // Transit LANs: no boxes, the router's line goes to the Cross Connect, named after the LAN.
    const cc = d.edges.filter((e) => e.kind === 'cross-connect')
    expect(cc.map((e) => [e.source, e.target, e.label, e.ref, !!e.onDemand])).toEqual(
      Array.from({ length: 4 }, (_, i) => ['edge-rtr', `cc:pcc${i}`, `t-${i}`, `t${i}`, false]),
    )
    for (let i = 0; i < 4; i++) {
      expect(has(d, `t${i}`)).toBe(false)
      expect(d.anchors.get(`t${i}`)).toBe(`t${i}->cc:pcc${i}`)
      expect(d.edges.some((e) => e.source === `cc:pcc${i}` && e.target === 'peer:peer')).toBe(true)
    }
    // Shared LANs: the first always, the other on demand with a marker.
    expect(lanLines(d, 'edge-rtr').map((e) => [e.source, e.target, !!e.onDemand])).toEqual([
      ['s0', 'edge-rtr', false],
      ['edge-rtr', 's1', true],
    ])
    expect(node(d, 's1').data.via).toBe('edge-rtr')
    expect(edgesOf(d, 'edge-rtr').filter((e) => !e.onDemand)).toHaveLength(5)
    expect(wired(d)).toBe(true)
    await layoutDiagram(d, new ELK())
  })

  it('keeps folded LANs reachable by search, selection and manual links', async () => {
    const m = routerModel({ shared: 2, stub: 3, transit: 1 })
    m.edges.push({ kind: 'manual', from: 't0', to: 'app1', label: 'GRE', ref: 'l1' } as GraphEdge)
    m.edges.push({ kind: 'manual', from: 'x2', to: 'app0', label: 'IPsec', ref: 'l2' } as GraphEdge)
    const d = datacenterDiagram(m, 'dc')
    const manual = d.edges.filter((e) => e.kind === 'manual').map((e) => [e.source, e.target])
    expect(manual).toEqual([
      ['edge-rtr', 'app1'],
      ['edge-rtr', 'app0'],
    ])
    expect(wired(d)).toBe(true)
    const l = await layoutDiagram(d, new ELK())
    const hit = toFlow(l, d, undefined, new Set(['x1']))
    expect(hit.nodes.find((n) => n.id === 'edge-rtr')!.data.matches).toBe(1)
    expect(toFlow(l, d, d.anchors.get('x1'), null).nodes.find((n) => n.id === 'edge-rtr')!.selected).toBe(true)
    const transit = toFlow(l, d, d.anchors.get('t0'), null).edges.find((e) => e.id === d.anchors.get('t0'))!
    expect(transit.className).toContain('hl')
  })

  it('keeps the layout signature whatever is selected', async () => {
    const d = datacenterDiagram(routerModel({ shared: 3, stub: 4, transit: 2, pub: true }), 'dc')
    const signature = layoutSignature(d)
    const l = await layoutDiagram(d, new ELK())
    for (const anchor of [undefined, 'edge-rtr', 's1', 'x0', 't1']) {
      const f = toFlow(l, d, d.anchors.get(anchor ?? '') ?? anchor, null)
      expect(f.nodes.map((n) => [n.id, n.position.x, n.position.y])).toEqual(l.nodes.map((n) => [n.id, n.x, n.y]))
    }
    expect(layoutSignature(datacenterDiagram(routerModel({ shared: 3, stub: 4, transit: 2, pub: true }), 'dc'))).toBe(signature)
    // Lines on demand are not part of it.
    expect(layoutSignature({ ...d, edges: d.edges.filter((e) => !e.onDemand) })).toBe(signature)
  })

  it('draws at most 2 lines at rest for a server in 16 LANs', () => {
    // The public LAN, 14 LANs with other servers and one only the router uses.
    const d = datacenterDiagram(routerModel({ pub: true, shared: 14, stub: 1 }), 'dc')
    expect(node(d, 'edge-rtr')).toMatchObject({ type: 'router', data: { lans: 16, only: { lans: ['x-0'] } } })
    expect(
      lanLines(d, 'edge-rtr')
        .filter((e) => !e.onDemand)
        .map((e) => [e.source, e.target]),
    ).toEqual([['pub', 'edge-rtr']])
    expect(lanLines(d, 'edge-rtr').filter((e) => e.onDemand)).toHaveLength(14)
    expect(d.nodes.filter((n) => n.data.via).map((n) => n.data.via)).toEqual(Array(14).fill('edge-rtr'))
  })

  it('never folds a public LAN', () => {
    const d = datacenterDiagram(routerModel({ pub: true, stub: 4 }), 'dc')
    expect(node(d, 'pub').type).toBe('lan')
    expect(lanLines(d, 'edge-rtr').map((e) => [e.source, e.target, !!e.onDemand])).toEqual([['pub', 'edge-rtr', false]])
    expect(node(d, 'edge-rtr').data.only?.lans).toHaveLength(4)
  })

  it('lets a router stand alone when all its LANs fold', async () => {
    const d = datacenterDiagram(routerModel({ stub: 3, transit: 2 }), 'dc')
    expect(d.nodes.filter((n) => n.type === 'lan')).toEqual([])
    expect(lanLines(d, 'edge-rtr')).toEqual([])
    expect(edgesOf(d, 'edge-rtr').map((e) => [e.kind, e.label])).toEqual([
      ['cross-connect', 't-0'],
      ['cross-connect', 't-1'],
    ])
    expect(wired(d)).toBe(true)
    const l = await layoutDiagram(d, new ELK())
    expect(l.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true)
  })

  it('treats a group of routers as one router', () => {
    const d = datacenterDiagram(routerModel({ shared: 8, stub: 2, routers: ['edge-rtr-01', 'edge-rtr-02'] }), 'dc')
    const g = d.nodes.find((n) => n.type === 'group')!
    expect(g.data).toMatchObject({ title: 'edge-rtr', lans: 10, only: { lans: ['x-0', 'x-1'], key: `lans:${g.id}` } })
    expect(d.anchors.get('x0')).toBe(g.id)
    expect(lanLines(d, 'edge-rtr-01')).toEqual([])
    expect(lanLines(d, g.id).filter((e) => !e.onDemand)).toHaveLength(1)
    expect(lanLines(d, g.id).filter((e) => e.onDemand)).toHaveLength(7)
    expect(node(d, 's1').data.via).toBe('edge-rtr')
  })

  it('keeps a LAN between two routers, drawn by the first', () => {
    const d = datacenterDiagram(routerModel({ shared: 3, stub: 1, routers: ['a-rtr', 'b-rtr'] }), 'dc')
    expect(['a-rtr', 'b-rtr'].map((r) => node(d, r).type)).toEqual(['router', 'router'])
    expect(node(d, 'x0').type).toBe('lan')
    expect(node(d, 'a-rtr').data.only).toBeUndefined()
    const always = d.edges.filter((e) => e.target === 'x0' && !e.onDemand).map((e) => e.source)
    expect(always).toEqual(['a-rtr'])
    expect(node(d, 'x0').data.via).toBe('b-rtr')
    expect(node(d, 's1').data.via).toBe('2 routers')
  })

  it('leaves a server in 3 LANs alone, even LANs only it uses', () => {
    const d = datacenterDiagram(routerModel({ pub: true, shared: 1, stub: 1 }), 'dc')
    expect(node(d, 'edge-rtr').type).toBe('resource')
    expect(node(d, 'x0').type).toBe('lan')
    expect(lanLines(d, 'edge-rtr').every((e) => !e.onDemand)).toBe(true)
    expect(d.nodes.some((n) => n.data.via || n.data.only)).toBe(false)
  })
})

describe('VPN tunnels, appliances and manual links', async () => {
  const snap = await fixtureModel()
  const fraVpn = named(snap, 'fra-core-vpn-01').id
  const txlVpn = named(snap, 'txl-core-vpn-01').id
  const [withSite, site] = addSite(EMPTY, { name: 'Head office', hosts: ['192.0.2.10'] })
  const m = applyAnnotations(snap, addLink(withSite, { from: fraVpn, to: txlVpn, label: 'IPsec in the VMs' })).model
  const mgmt = named(m, 'fra-mgmt').id
  const txl = named(m, 'txl-prod-core').id

  it('draws tunnels and links between datacenters on the contract view', () => {
    const d = contractDiagram(m)
    const pair = (a: string, b: string) => [a, b].sort().join(' ↔ ')
    const line = (kind: string) => d.edges.filter((e) => e.kind === kind).map((e) => [pair(e.source, e.target), e.label])
    expect(line('tunnel')).toEqual([
      [pair(mgmt, siteNodeId(site)), 'hq-office'],
      [pair(mgmt, txl), 'txl-core'],
      [pair(named(m, 'lhr-staging').id, 'ext:192.0.2.77'), 'build-agent-uk'],
    ])
    expect(line('manual')).toEqual([[pair(named(m, 'fra-prod-core').id, txl), 'IPsec in the VMs']])
    const outside = d.nodes.filter((n) => n.parent === 'group:external').map((n) => n.data.title)
    expect(outside).toEqual(['192.0.2.77', 'Head office'])
    expect(node(d, named(m, 'fra-prod-core').id).data.pills).toContain('4 appliances')
    expect(d.anchors.get(named(m, 'txl-core').id)).toBe(d.edges.find((e) => e.label === 'txl-core')!.id)
  })

  it('routes the lines between locations around the cards on the contract view', async () => {
    const elk = new ELK()
    const d = contractDiagram(m)
    const l = await layoutDiagram(d, elk)
    const abs = absolutePositions(l)
    const parent = new Map(d.nodes.map((n) => [n.id, n.parent]))
    const across = l.edges.filter((e) => parent.get(e.source) !== parent.get(e.target))
    expect(across.map((e) => e.kind).sort()).toEqual(['manual', 'tunnel', 'tunnel', 'tunnel'])
    const inside = (p: { x: number; y: number }, id: string, pad: number) => {
      const b = abs.get(id)!
      return p.x >= b.x - pad && p.x <= b.x + b.width + pad && p.y >= b.y - pad && p.y <= b.y + b.height + pad
    }
    for (const e of l.edges) {
      const pts = e.points!
      expect(pts.length, e.id).toBeGreaterThanOrEqual(2)
      expect(inside(pts[0], e.source, 1) && inside(pts.at(-1)!, e.target, 1), e.id).toBe(true)
      // Orthogonal segments: a segment's bounding box is the segment.
      for (const n of l.nodes) {
        if (n.type === 'group' || n.id === e.source || n.id === e.target) continue
        const b = abs.get(n.id)!
        const hit = pts.slice(1).some((q, i) => {
          const p = pts[i]
          return (
            Math.max(p.x, q.x) > b.x &&
            Math.min(p.x, q.x) < b.x + b.width &&
            Math.max(p.y, q.y) > b.y &&
            Math.min(p.y, q.y) < b.y + b.height
          )
        })
        expect(hit, `${e.id} crosses ${n.data.title}`).toBe(false)
      }
    }

    // Locations no line joins keep the layout they had on their own; without
    // the lines (the "links" layer hidden) the whole view does.
    const own = await layoutDiagram({ ...d, linkedLayout: undefined }, elk)
    const at = (l: Layout, parentId: string) => l.nodes.filter((n) => n.parent === parentId).map((n) => [n.id, n.x, n.y])
    for (const g of ['loc:es/vit', 'loc:de/fra/2', 'group:unused-pcc']) expect(at(l, g)).toEqual(at(own, g))
    const cut = contractDiagram(m, { hidden: new Set(['links']) })
    const plain = await layoutDiagram({ ...cut, linkedLayout: undefined }, elk)
    expect((await layoutDiagram(cut, elk)).nodes).toEqual(plain.nodes)
  })

  it('shows a VPN gateway between the internet and its LAN, with its tunnels', () => {
    const d = datacenterDiagram(m, mgmt)
    const gw = named(m, 'vpngw-mgmt')
    expect(node(d, gw.id).type).toBe('resource')
    expect(edgesOf(d, gw.id).map((e) => [e.kind, node(d, e.source).data.title, node(d, e.target).data.title])).toEqual([
      ['internet', 'Internet', 'vpngw-mgmt'],
      ['lan', 'vpngw-mgmt', 'mgmt'],
      ['tunnel', 'Head office', 'vpngw-mgmt'],
      ['tunnel', 'txl-prod-core', 'vpngw-mgmt'],
    ])
    expect(node(d, `x:${siteNodeId(site)}`).type).toBe('external')
    expect(node(d, `peer:${txl}`).type).toBe('peer')
  })

  it('tags appliances and draws manual links to the other datacenter', () => {
    const d = datacenterDiagram(m, named(m, 'fra-prod-core').id)
    expect(node(d, fraVpn).data).toMatchObject({ tag: 'Cisco Catalyst 8000V', tagLevel: 'high' })
    const link = d.edges.find((e) => e.kind === 'manual')!
    expect([link.source, link.target, link.label]).toEqual([`peer:${txl}`, fraVpn, 'IPsec in the VMs'])
  })

  it('lays the new elements out without overlaps', async () => {
    const elk = new ELK()
    for (const d of [contractDiagram(m), datacenterDiagram(m, mgmt), datacenterDiagram(m, named(m, 'lhr-staging').id)]) {
      const l = await layoutDiagram(d, elk)
      const roots = l.nodes.filter((n) => !n.parent)
      for (const a of roots)
        for (const b of roots) {
          if (a === b) continue
          expect(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height, `${a.id} / ${b.id}`).toBe(
            false,
          )
        }
    }
  })
})

/**
 * One datacenter `dc` with a farm of `servers` web servers on one LAN (each
 * with a NIC, the first ones with a volume), a load balancer targeting all
 * of them, and `volumes` unattached volumes.
 */
function farmModel(servers: number, volumes = 0): Model {
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const add = (p: Partial<GraphNode> & Pick<GraphNode, 'id' | 'kind' | 'name'>) =>
    nodes.set(p.id, { ips: [], macs: [], labels: {}, facts: [], terms: [], searchText: '', raw: null, ...p })
  add({ id: 'root', kind: 'contract', name: 'Contract' })
  add({ id: 'dc', kind: 'datacenter', name: 'dc', dcId: 'dc', parentId: 'root' })
  add({ id: 'pub', kind: 'lan', name: 'public', subtype: 'public', dcId: 'dc', parentId: 'dc' })
  add({ id: 'web', kind: 'lan', name: 'web', subtype: 'private', dcId: 'dc', parentId: 'dc' })
  add({ id: 'nlb', kind: 'nlb', name: 'web-nlb', dcId: 'dc', parentId: 'dc' })
  edges.push({ kind: 'listener', from: 'nlb', to: 'pub' }, { kind: 'target-lan', from: 'nlb', to: 'web' })
  for (let i = 1; i <= servers; i++) {
    add({ id: `w${i}`, kind: 'server', name: `web-${String(i).padStart(2, '0')}`, dcId: 'dc', parentId: 'dc' })
    add({ id: `w${i}-nic`, kind: 'nic', name: 'nic', dcId: 'dc', parentId: `w${i}` })
    add({ id: `w${i}-vol`, kind: 'volume', name: `web-${i}-data`, dcId: 'dc', parentId: 'dc' })
    edges.push(
      { kind: 'member', from: `w${i}`, to: 'web' },
      { kind: 'attached', from: `w${i}`, to: `w${i}-vol` },
      { kind: 'target', from: 'nlb', to: `w${i}` },
    )
  }
  for (let i = 1; i <= volumes; i++) add({ id: `v${i}`, kind: 'volume', name: `old-${i}`, dcId: 'dc', parentId: 'dc' })
  const children = new Map<string, string[]>()
  const edgesByNode = new Map<string, GraphEdge[]>()
  for (const n of nodes.values()) if (n.parentId) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n.id])
  for (const e of edges) for (const id of [e.from, e.to]) edgesByNode.set(id, [...(edgesByNode.get(id) ?? []), e])
  return { rootId: 'root', nodes, edges, children, edgesByNode, coverageIssues: [], warnings: [] } as unknown as Model
}

describe('large groups', () => {
  const gid = 'grp:web|web'
  const more = `more:${gid}`
  const members = (d: Diagram, g = gid) => d.nodes.filter((n) => n.parent === g && n.type === 'member').map((n) => n.data.title)
  const webs = (...i: number[]) => i.map((x) => `web-${String(x).padStart(2, '0')}`)
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

  it('previews the first members and keeps those that matter', () => {
    const list = range(1, 30)
    expect(preview(list, false, () => false)).toEqual({ shown: range(1, GROUP_PREVIEW), hidden: range(7, 30) })
    expect(preview(list, true, () => false).hidden).toEqual([])
    expect(preview(range(1, GROUP_LIMIT), false, () => false).hidden).toEqual([])
    // Pinned members take room from the preview.
    expect(preview(list, false, (x) => x === 20 || x === 3).shown).toEqual([1, 2, 3, 4, 5, 20])
    expect(preview(list, false, (x) => x > 22).shown).toEqual(range(23, 30))
    // A "more" box never stands for one member.
    expect(preview(range(1, 9), false, (x) => x > 1)).toEqual({ shown: range(1, 9), hidden: [] })
    expect(preview(range(1, 9), false, (x) => x > 2)).toEqual({ shown: range(3, 9), hidden: [1, 2] })
  })

  it('draws a group of 30 collapsed: 6 members and "+24 more"', () => {
    const d = datacenterDiagram(farmModel(30), 'dc')
    expect(node(d, gid).data).toMatchObject({ title: 'web', subtitle: '30 servers' })
    expect(node(d, gid).data.collapsible).toBeUndefined()
    expect(members(d)).toEqual(webs(1, 2, 3, 4, 5, 6))
    expect(node(d, more)).toMatchObject({ type: 'more', parent: gid, width: 196, height: 42, data: { title: '+24 more', more: 24 } })
    expect(d.nodes.filter((n) => n.parent === gid).at(-1)!.id).toBe(more)
    // Hidden members, their NICs and volumes are found on the "more" box.
    for (const id of ['w7', 'w30', 'w12-nic', 'w20-vol']) expect(d.anchors.get(id)).toBe(more)
    expect(d.anchors.get('w6')).toBe('w6')
    expect(d.anchors.get('w6-nic')).toBe('w6')
    // The LAN line stays on the group; load balancer targets: one line to the "more" box.
    expect(edgesOf(d, gid).map((e) => e.source)).toEqual(['web'])
    const targets = d.edges.filter((e) => e.kind === 'target')
    expect(targets.map((e) => e.target)).toEqual([...range(1, 6).map((i) => `w${i}`), more])
    expect(targets.every((e) => e.onDemand)).toBe(true)
  })

  it('shows every member when expanded, with a way back', () => {
    const d = datacenterDiagram(farmModel(30), 'dc', { expanded: new Set([gid]) })
    expect(members(d)).toHaveLength(30)
    expect(d.nodes.some((n) => n.type === 'more')).toBe(false)
    expect(node(d, gid).data.collapsible).toBe(true)
    expect(d.anchors.get('w30')).toBe('w30')
    // A small group has nothing to collapse.
    const small = datacenterDiagram(farmModel(8), 'dc', { expanded: new Set([gid]) })
    expect(members(small)).toHaveLength(8)
    expect(node(small, gid).data.collapsible).toBeUndefined()
  })

  it('always shows the selection, appliances and changes', () => {
    const sel = (selected: string) => members(datacenterDiagram(farmModel(30), 'dc', { selected }))
    expect(sel('w17')).toEqual(webs(1, 2, 3, 4, 5, 17))
    // A NIC or volume: its server.
    expect(sel('w20-nic')).toEqual(webs(1, 2, 3, 4, 5, 20))
    expect(sel('w25-vol')).toEqual(webs(1, 2, 3, 4, 5, 25))
    expect(sel('w2')).toEqual(webs(1, 2, 3, 4, 5, 6))
    const d17 = datacenterDiagram(farmModel(30), 'dc', { selected: 'w17' })
    expect(node(d17, more).data.more).toBe(24)
    expect(d17.anchors.get('w17')).toBe('w17')
    expect(d17.anchors.get('w6')).toBe(more)

    const m = farmModel(30)
    m.nodes.get('w9')!.appliance = { title: 'firewall', confidence: 'medium', reasons: [] }
    m.nodes.get('w28')!.change = 'added'
    m.nodes.get('w11')!.change = 'changed'
    const d = datacenterDiagram(m, 'dc', { selected: 'w30' })
    expect(members(d)).toEqual(webs(1, 2, 9, 11, 28, 30))
    expect(node(d, more).data.more).toBe(24)
  })

  it('counts search hits among hidden members on the "more" box', async () => {
    const d = datacenterDiagram(farmModel(30), 'dc')
    const l = await layoutDiagram(d, new ELK())
    // Three hidden members match (one also through its volume, one only through its NIC).
    const f = toFlow(l, d, undefined, new Set(['w2', 'w12', 'w12-vol', 'w13-nic', 'w14']))
    const flowNode = (id: string) => f.nodes.find((n) => n.id === id)!
    expect(flowNode(more).data.matches).toBe(3)
    expect(d.hidden?.get('w13-nic')).toBe('w13')
    expect(d.hidden?.has('w2')).toBe(false)
    expect(flowNode('w2').data.matches).toBe(1)
    expect(flowNode(more).data.dim).toBe(false)
    expect(flowNode('w3').data.dim).toBe(true)
    expect(flowNode(more).selectable).toBe(false)
  })

  it('lays the collapsed and the expanded group out separately, the selection inside the same box', async () => {
    const m = farmModel(30)
    const elk = new ELK()
    const rest = datacenterDiagram(m, 'dc')
    const open = datacenterDiagram(m, 'dc', { expanded: new Set([gid]) })
    const picked = datacenterDiagram(m, 'dc', { selected: 'w17' })
    expect(layoutSignature(open)).not.toBe(layoutSignature(rest))
    expect(layoutSignature(picked)).not.toBe(layoutSignature(rest))
    // Selecting what is shown anyway, or something else, keeps the layout.
    for (const selected of ['w3', 'nlb', 'web'])
      expect(layoutSignature(datacenterDiagram(m, 'dc', { selected }))).toBe(layoutSignature(rest))
    expect(layoutSignature(datacenterDiagram(m, 'dc', { expanded: new Set(['grp:other']) }))).toBe(layoutSignature(rest))
    const size = async (d: Diagram) => {
      const g = (await layoutDiagram(d, elk)).nodes.find((n) => n.id === gid)!
      return [g.width, g.height]
    }
    // A revealed member takes the place of a previewed one: the group keeps its size.
    expect(await size(picked)).toEqual(await size(rest))
    const [w, h] = await size(open)
    expect(w * h).toBeGreaterThan((await size(rest)).reduce((a, b) => a * b))
  })

  it('collapses large leftover groups too', () => {
    const d = datacenterDiagram(farmModel(2, 12), 'dc')
    const g = titled(d, 'Unattached volumes')
    expect(g.data.subtitle).toBe('12 resources')
    expect(members(d, g.id)).toEqual(['old-1', 'old-2', 'old-3', 'old-4', 'old-5', 'old-6'])
    expect(node(d, `more:${g.id}`).data.title).toBe('+6 more')
    expect(d.anchors.get('v12')).toBe(`more:${g.id}`)
    expect(members(datacenterDiagram(farmModel(2, 12), 'dc', { selected: 'v12' }), g.id)).toContain('old-12')
    expect(members(datacenterDiagram(farmModel(2, 12), 'dc', { expanded: new Set([g.id]) }), g.id)).toHaveLength(12)
  })

  it('unfolds a router’s LANs through the same switch', async () => {
    const m = routerModel({ shared: 2, stub: 3, transit: 1 })
    const folded = datacenterDiagram(m, 'dc')
    const open = datacenterDiagram(m, 'dc', { expanded: new Set(['lans:edge-rtr']) })
    expect(node(open, 'edge-rtr').data.only).toEqual({ lans: ['x-0', 'x-1', 'x-2'], key: 'lans:edge-rtr', open: true })
    for (const id of ['x0', 'x1', 'x2', 't0']) {
      expect(open.nodes.some((n) => n.id === id)).toBe(true)
      expect(open.anchors.get(id)).toBe(id)
    }
    // Stub LANs hang off the router; the transit LAN leads to its Cross Connect again.
    expect(open.edges.filter((e) => e.source === 'edge-rtr' && /^x\d$/.test(e.target) && !e.onDemand)).toHaveLength(3)
    expect(open.edges.some((e) => e.source === 't0' && e.target === 'cc:pcc0')).toBe(true)
    expect(layoutSignature(open)).not.toBe(layoutSignature(folded))
    await layoutDiagram(open, new ELK())
  })

  it('collapses the demo shop’s web farm', () => {
    return fixtureModel().then((m) => {
      const d = datacenterDiagram(m, named(m, 'fra-prod-shop').id)
      const g = titled(d, 'shop-web')
      expect(g.data.subtitle).toBe('12 servers · Cube')
      expect(members(d, g.id)).toEqual(['shop-web-01', 'shop-web-02', 'shop-web-03', 'shop-web-04', 'shop-web-05', 'shop-web-06'])
      expect(node(d, `more:${g.id}`).data.title).toBe('+6 more')
    })
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
