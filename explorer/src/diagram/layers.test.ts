import ELK from 'elkjs/lib/elk.bundled.js'
import { describe, expect, it } from 'vitest'
import { addLink, addSite, applyAnnotations, EMPTY } from '../annotations/annotations'
import { compareModels, markChanges } from '../diff/diff'
import type { Model, NodeKind } from '../model/types'
import { fixtureModel, previousFixtureModel } from '../test/fixture'
import { contractDiagram, datacenterDiagram } from './build'
import { toFlow } from './flow'
import { emphasized, LAYERS, NO_LAYERS, parseLayers, serializeLayers, type Layer } from './layers'
import { layoutDiagram, layoutSignature } from './layout'
import type { Diagram, DiagramNode } from './types'

const named = (m: Model, name: string) => [...m.nodes.values()].find((n) => n.name === name)!

describe('stored layers', () => {
  it('round-trips and ignores what it does not know', () => {
    const l = { hidden: new Set<Layer>(['peers', 'lb']), emphasis: 'changes' as const }
    const back = parseLayers(serializeLayers(l))
    expect([...back.hidden].sort()).toEqual(['lb', 'peers'])
    expect(back.emphasis).toBe('changes')
    expect(parseLayers('{"hidden":["lb","nope",3],"emphasis":"loud"}')).toEqual({ hidden: new Set(['lb']), emphasis: undefined })
    expect(parseLayers('not json')).toBe(NO_LAYERS)
    expect(parseLayers(null)).toBe(NO_LAYERS)
  })
})

describe('layer switches', async () => {
  // The demo with one manual link and a site, so every layer has something to hide.
  const snap = await fixtureModel()
  const [withSite] = addSite(EMPTY, { name: 'Head office', hosts: ['192.0.2.10'] })
  const m = applyAnnotations(
    snap,
    addLink(withSite, { from: named(snap, 'fra-core-vpn-01').id, to: named(snap, 'txl-core-vpn-01').id, label: 'IPsec' }),
  ).model
  const dcs = [...m.nodes.values()].filter((n) => n.kind === 'datacenter').map((n) => n.id)
  const kindOf = (n: DiagramNode) => (n.ref ? m.nodes.get(n.ref)?.kind : undefined)
  const resources = (kinds: NodeKind[]) => (n: DiagramNode) => n.type !== 'peer' && kinds.includes(kindOf(n)!)
  const LEFTOVERS = ['grp:Unattached volumes', 'grp:Security Groups', 'grp:Other resources']

  /**
   * What a layer may take away: its own boxes, lines of its own kind and the
   * lines ending at those boxes, and then the internet, peer datacenters and
   * endpoints outside that were there only for such lines.
   */
  const expected: Record<Layer, { node: (n: DiagramNode) => boolean; edge: string[] }> = {
    lb: { node: resources(['nlb', 'alb']), edge: [] },
    gateways: { node: resources(['natgateway', 'vpngateway']), edge: [] },
    managed: { node: resources(['nodepool', 'postgres']), edge: [] },
    links: { node: () => false, edge: ['tunnel', 'manual'] },
    leftovers: { node: (n) => LEFTOVERS.includes(n.id) || LEFTOVERS.includes(n.parent ?? ''), edge: [] },
    peers: { node: () => false, edge: ['peer'] },
  }
  const ENDS = new Set(['internet', 'peer', 'external'])

  const removed = (full: Diagram, cut: Diagram, layer: Layer) => {
    const kept = new Set(cut.nodes.map((n) => n.id))
    const keptEdges = new Set(cut.edges.map((e) => e.id))
    const want = new Set(full.nodes.filter((n) => expected[layer].node(n)).map((n) => n.id))
    const lines = (ids: Set<string>) =>
      full.edges.filter((e) => expected[layer].edge.includes(e.kind) || ids.has(e.source) || ids.has(e.target))
    const wantEdges = new Set(lines(want).map((e) => e.id))
    for (const n of full.nodes) {
      const own = full.edges.filter((e) => e.source === n.id || e.target === n.id)
      if (ENDS.has(n.type) && own.length && own.every((e) => wantEdges.has(e.id))) want.add(n.id)
    }
    // Nothing new comes in.
    const fullIds = new Set(full.nodes.map((n) => n.id))
    const fullEdges = new Set(full.edges.map((e) => e.id))
    expect(cut.nodes.filter((n) => !fullIds.has(n.id)).map((n) => n.id)).toEqual([])
    expect(cut.edges.filter((e) => !fullEdges.has(e.id)).map((e) => e.id)).toEqual([])
    return {
      gone: full.nodes.filter((n) => !kept.has(n.id)).map((n) => n.id),
      want: full.nodes.filter((n) => want.has(n.id)).map((n) => n.id),
      goneEdges: full.edges.filter((e) => !keptEdges.has(e.id)).map((e) => e.id),
      wantEdges: lines(want).map((e) => e.id),
    }
  }

  it.each(LAYERS.map((l) => l.id))('"%s" removes exactly its boxes and lines in every datacenter view', (layer) => {
    let total = 0
    for (const dc of dcs) {
      const full = datacenterDiagram(m, dc)
      const cut = datacenterDiagram(m, dc, { hidden: new Set([layer]) })
      const r = removed(full, cut, layer)
      expect(r.gone).toEqual(r.want)
      expect(r.goneEdges).toEqual(r.wantEdges)
      total += r.gone.length + r.goneEdges.length
    }
    expect(total).toBeGreaterThan(0) // the demo has something of each layer
  })

  it('hides tunnels, manual links and the endpoints outside on the contract view, nothing else', () => {
    const full = contractDiagram(m)
    for (const l of LAYERS.map((x) => x.id).filter((x) => x !== 'links')) {
      expect(layoutSignature(contractDiagram(m, { hidden: new Set([l]) }))).toBe(layoutSignature(full))
    }
    const cut = contractDiagram(m, { hidden: new Set(['links']) })
    const r = removed(full, cut, 'links')
    expect(r.gone).toEqual(['group:external', ...r.want])
    expect(r.goneEdges).toEqual(r.wantEdges)
    expect(r.goneEdges.length).toBe(4)
    expect(cut.edges.some((e) => e.kind === 'tunnel' || e.kind === 'manual')).toBe(false)
  })

  it('keeps every anchor of a shown box valid', () => {
    for (const dc of dcs) {
      const d = datacenterDiagram(m, dc, { hidden: new Set(LAYERS.map((l) => l.id)) })
      const ids = new Set([...d.nodes.map((n) => n.id), ...d.edges.map((e) => e.id)])
      expect([...d.anchors.values()].filter((a) => !ids.has(a))).toEqual([])
      const boxes = new Set(d.nodes.map((n) => n.id))
      expect(d.edges.filter((e) => !boxes.has(e.source) || !boxes.has(e.target))).toEqual([])
    }
  })
})

describe('emphasis', async () => {
  const newer = await fixtureModel()
  const m = markChanges(newer, compareModels(await previousFixtureModel(), newer))
  const core = named(m, 'fra-prod-core').id
  const d = datacenterDiagram(m, core)
  const l = await layoutDiagram(d, new ELK())

  it('only dims: the diagram and its layout signature stay the same', () => {
    const signature = layoutSignature(d)
    for (const e of ['appliances', 'changes'] as const) {
      // The canvas builds the diagram from the hidden layers only; the emphasis goes to toFlow.
      expect(layoutSignature(datacenterDiagram(m, core, { hidden: new Set() }))).toBe(signature)
      const plain = toFlow(l, d, undefined, null)
      const lit = toFlow(l, d, undefined, null, emphasized(m, e, true))
      expect(lit.nodes.map((n) => [n.id, n.position])).toEqual(plain.nodes.map((n) => [n.id, n.position]))
      expect(lit.nodes.some((n) => n.data.matches > 0)).toBe(false)
    }
    expect(emphasized(m, undefined, true)).toBeNull()
    expect(emphasized(m, 'changes', false)).toBeNull() // no comparison, nothing to emphasise
  })

  it('"Only appliances" keeps the appliances and their groups bright', () => {
    const f = toFlow(l, d, undefined, null, emphasized(m, 'appliances', true))
    const bright = f.nodes.filter((n) => !n.data.dim).map((n) => n.data.node.data.title)
    expect(bright.sort()).toEqual(['fra-core-fw', 'fra-core-fw-01', 'fra-core-fw-02', 'fra-core-hub-01', 'fra-core-vpn-01'])
  })

  it('"Only changes" keeps what changed bright, and the groups around it', () => {
    const f = toFlow(l, d, undefined, null, emphasized(m, 'changes', true))
    const bright = f.nodes.filter((n) => !n.data.dim).map((n) => n.data.node)
    const changed = d.nodes.filter((n) => n.data.change).map((n) => n.id)
    expect(changed.length).toBeGreaterThan(0)
    for (const id of changed) expect(bright.map((n) => n.id)).toContain(id)
    // Bright: changed boxes, boxes that show a changed NIC or volume, and their groups.
    expect(bright.length).toBeLessThan(d.nodes.length / 2)
    expect(f.edges.filter((e) => !e.className!.includes('dim')).length).toBeLessThan(f.edges.length)
  })

  it('works on the contract view too', () => {
    const c = contractDiagram(m)
    const anchorsOfChanges = new Set([...emphasized(m, 'changes', true)!].map((id) => c.anchors.get(id)))
    const cards = c.nodes.filter((n) => n.type === 'dc' && anchorsOfChanges.has(n.id)).map((n) => n.data.title)
    expect(cards.length).toBeGreaterThan(0)
    expect(cards.length).toBeLessThan(c.nodes.filter((n) => n.type === 'dc').length)
  })
})
