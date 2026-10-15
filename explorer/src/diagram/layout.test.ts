import ELK from 'elkjs/lib/elk.bundled.js'
import { describe, expect, it } from 'vitest'
import { applyAnnotations, EMPTY } from '../annotations/annotations'
import { compareModels, markChanges } from '../diff/diff'
import { fixtureModel, previousFixtureModel } from '../test/fixture'
import { contractDiagram, datacenterDiagram } from './build'
import { absolutePositions, layoutCache, layoutDiagram, layoutSignature, linkedBoxes, withData } from './layout'
import type { Diagram, Layout } from './types'

// Two servers on one LAN in a group, a load balancer target shown on demand,
// and a link from inside the group to a box outside it (not routed by ELK).
function sample(): Diagram {
  return {
    key: 'dc:x',
    rootLayout: { 'elk.algorithm': 'layered' },
    nodes: [
      { id: 'g', type: 'group', layout: { 'elk.algorithm': 'layered' }, data: { title: 'web' } },
      { id: 'lan', type: 'lan', parent: 'g', width: 300, height: 44, data: { title: 'lan 1' } },
      { id: 'a', type: 'resource', parent: 'g', width: 236, height: 54, data: { title: 'web-01', pills: ['2 vCPU'] } },
      { id: 'b', type: 'resource', parent: 'g', width: 236, height: 54, data: { title: 'web-02' } },
      { id: 'out', type: 'external', width: 210, height: 52, data: { title: 'site' } },
    ],
    edges: [
      { id: 'a-lan', source: 'a', target: 'lan', kind: 'lan' },
      { id: 'b-lan', source: 'b', target: 'lan', kind: 'lan' },
      { id: 'a-b', source: 'a', target: 'b', kind: 'target', onDemand: true },
      { id: 'a-out', source: 'a', target: 'out', kind: 'manual', label: 'vpn' },
    ],
    anchors: new Map(),
  }
}

const edit = (fn: (d: Diagram) => void) => {
  const d = structuredClone(sample())
  fn(d)
  return d
}

describe('layoutSignature', () => {
  const base = layoutSignature(sample())

  it('ignores what only affects rendering', () => {
    const d = edit((d) => {
      d.nodes[2].data = { title: 'renamed', subtitle: '10.0.0.1', pills: ['4 vCPU'], tag: 'Cisco', tagLevel: 'high', change: 'changed' }
      d.nodes[0].ref = 'model-id'
      d.edges[3].label = 'other label'
      d.edges[0].kind = 'internet'
      // Neither on-demand nor cross-group edges are routed by ELK.
      d.edges.push({ id: 'b-out', source: 'b', target: 'out', kind: 'manual' })
      d.edges.push({ id: 'b-a', source: 'b', target: 'a', kind: 'target', onDemand: true })
    })
    expect(layoutSignature(d)).toBe(base)
  })

  it('changes with sizes, parents, types, options and routed edges', () => {
    const changed = [
      edit((d) => (d.nodes[2].width = 196)),
      edit((d) => (d.nodes[2].height = 42)),
      edit((d) => (d.nodes[4].parent = 'g')),
      edit((d) => (d.nodes[2].type = 'member')),
      edit((d) => (d.nodes[0].layout = { 'elk.algorithm': 'rectpacking' })),
      edit((d) => (d.rootLayout = { 'elk.direction': 'RIGHT' })),
      edit((d) => d.edges.push({ id: 'a-b2', source: 'a', target: 'b', kind: 'manual' })),
      edit((d) => (d.edges[2].onDemand = false)),
      edit((d) => d.edges.splice(0, 1)),
      edit((d) => d.nodes.reverse()),
      edit((d) => (d.key = 'dc:y')),
      edit((d) => (d.linkedLayout = { 'elk.algorithm': 'layered' })),
      edit((d) => (d.directed = true)),
    ]
    for (const d of changed) expect(layoutSignature(d)).not.toBe(base)
    expect(new Set(changed.map(layoutSignature)).size).toBe(changed.length)
  })

  it('stays the same when a comparison rebuilds the model', async () => {
    const [older, m] = await Promise.all([previousFixtureModel(), fixtureModel()])
    const marked = markChanges(applyAnnotations(m, EMPTY).model, compareModels(older, m))
    expect(contractDiagram(marked).nodes.some((n) => n.data.changes)).toBe(true)
    expect(layoutSignature(contractDiagram(marked))).toBe(layoutSignature(contractDiagram(m)))
    for (const dc of [...m.nodes.values()].filter((n) => n.kind === 'datacenter'))
      expect(layoutSignature(datacenterDiagram(marked, dc.id))).toBe(layoutSignature(datacenterDiagram(m, dc.id)))
  })
})

describe('linked boxes', () => {
  // A second group, and a line from it back to the first: lines across groups.
  const linked = () =>
    edit((d) => {
      d.linkedLayout = { 'elk.algorithm': 'layered', 'elk.direction': 'DOWN', 'elk.edgeRouting': 'ORTHOGONAL' }
      d.nodes.push(
        {
          id: 'h',
          type: 'group',
          layout: { 'elk.algorithm': 'rectpacking', 'elk.padding': '[top=40,left=16,bottom=16,right=16]' },
          data: { title: 'h' },
        },
        { id: 'c', type: 'resource', parent: 'h', width: 236, height: 54, data: { title: 'c' } },
        { id: 'alone', type: 'group', layout: { 'elk.algorithm': 'rectpacking' }, data: { title: 'alone' } },
        { id: 'd', type: 'resource', parent: 'alone', width: 236, height: 54, data: { title: 'd' } },
      )
      d.edges.push({ id: 'c-a', source: 'c', target: 'a', kind: 'tunnel' })
    })

  it('joins the top-level boxes that lines across groups link', () => {
    const { top, cluster } = linkedBoxes(linked())
    expect(top('a')).toBe('g')
    expect(top('alone')).toBe('alone')
    // g–out (a-out) and h–g (c-a): one linked box; on-demand lines do not count.
    expect([...cluster.keys()]).toEqual(['g', 'out', 'h'])
    expect(new Set(cluster.values()).size).toBe(1)
    expect(linkedBoxes(sample()).cluster.size).toBe(0)
  })

  it('routes lines across groups, from their source to their target', async () => {
    const l = await layoutDiagram(linked(), new ELK())
    const abs = absolutePositions(l)
    const on = (p: { x: number; y: number }, id: string) => {
      const b = abs.get(id)!
      return p.x >= b.x - 1 && p.x <= b.x + b.width + 1 && p.y >= b.y - 1 && p.y <= b.y + b.height + 1
    }
    for (const id of ['a-out', 'c-a', 'a-lan']) {
      const e = l.edges.find((e) => e.id === id)!
      expect(e.points!.length, id).toBeGreaterThanOrEqual(2)
      // c-a points back from the later group to the earlier one, so ELK gets it flipped; the route is turned back.
      expect(on(e.points![0], e.source) && on(e.points!.at(-1)!, e.target), id).toBe(true)
    }
    expect(l.edges.find((e) => e.id === 'a-b')!.points).toBeUndefined()
    // The invisible linked box is not a node; its boxes stay top level and inside their groups.
    expect(l.nodes.map((n) => n.id).sort()).toEqual(['a', 'alone', 'b', 'c', 'd', 'g', 'h', 'lan', 'out'])
    for (const n of l.nodes.filter((n) => n.parent)) {
      const [c, p] = [abs.get(n.id)!, abs.get(n.parent!)!]
      expect(c.x >= p.x && c.y >= p.y && c.x + c.width <= p.x + p.width && c.y + c.height <= p.y + p.height, n.id).toBe(true)
    }
  })

  it('also joins two top-level boxes a line links, since the root routes nothing', async () => {
    const d = linked()
    d.nodes.push({ id: 'peer', type: 'peer', width: 220, height: 52, data: { title: 'peer' } })
    d.edges.push({ id: 'out-peer', source: 'out', target: 'peer', kind: 'peer' })
    expect(linkedBoxes(d).cluster.get('peer')).toBe(linkedBoxes(d).cluster.get('out'))
    const l = await layoutDiagram(d, new ELK())
    expect(l.edges.find((e) => e.id === 'out-peer')!.points!.length).toBeGreaterThanOrEqual(2)
  })

  it('keeps the own algorithm of a group no line enters (lines end at its box)', async () => {
    const d = linked()
    d.nodes.push(
      { id: 'farm', type: 'group', parent: 'g', layout: { 'elk.algorithm': 'rectpacking' }, data: { title: 'farm' } },
      ...[1, 2, 3, 4].map((i) => ({
        id: `f${i}`,
        type: 'member' as const,
        parent: 'farm',
        width: 196,
        height: 42,
        data: { title: `f${i}` },
      })),
    )
    d.edges.push({ id: 'lan-farm', source: 'lan', target: 'farm', kind: 'lan' })
    const l = await layoutDiagram(d, new ELK())
    // Packed in rows, not laid out as one layer of a layered graph.
    expect(new Set(l.nodes.filter((n) => n.parent === 'farm').map((n) => n.y)).size).toBeGreaterThan(1)
    expect(l.edges.find((e) => e.id === 'lan-farm')!.points).toBeDefined()
  })

  it('keeps the direction of lines in a directed diagram', async () => {
    const order = async (directed: boolean) => {
      const l = await layoutDiagram({ ...linked(), directed }, new ELK())
      const abs = absolutePositions(l)
      return abs.get('h')!.y < abs.get('g')!.y ? 'h first' : 'g first'
    }
    // c-a points from h to g: turned round, g (earlier in the diagram) comes first; kept, h does.
    expect(await order(false)).toBe('g first')
    expect(await order(true)).toBe('h first')
  })
})

describe('withData', () => {
  it('puts the current data on the cached positions', async () => {
    const layout = await layoutDiagram(sample(), new ELK())
    const d = edit((d) => {
      d.key = 'dc:x'
      d.nodes[2].data = { title: 'renamed', change: 'added' }
      d.edges[3].label = 'new label'
      d.edges.push({ id: 'b-out', source: 'b', target: 'out', kind: 'manual' })
    })
    expect(layoutSignature(d)).toBe(layoutSignature(sample()))
    const l = withData(layout, d)
    expect(l.nodes.map((n) => [n.id, n.x, n.y, n.width, n.height])).toEqual(layout.nodes.map((n) => [n.id, n.x, n.y, n.width, n.height]))
    expect(l.nodes.find((n) => n.id === 'a')!.data).toEqual({ title: 'renamed', change: 'added' })
    // The group is sized by the layout, not the diagram.
    expect(l.nodes.find((n) => n.id === 'g')!.width).toBeGreaterThan(0)
    expect(l.edges.map((e) => e.id)).toEqual(['a-lan', 'b-lan', 'a-b', 'a-out', 'b-out'])
    expect(l.edges.find((e) => e.id === 'a-out')!.label).toBe('new label')
    expect(l.edges.find((e) => e.id === 'a-lan')!.points).toEqual(layout.edges.find((e) => e.id === 'a-lan')!.points)
    expect(l.edges.find((e) => e.id === 'a-lan')!.points!.length).toBeGreaterThan(1)
    expect(l.edges.find((e) => e.id === 'b-out')!.points).toBeUndefined()
  })
})

describe('layoutCache', () => {
  const fake = () => {
    const runs: string[] = []
    const run = (d: Diagram) => {
      runs.push(d.key)
      return d.key === 'fail' ? Promise.reject(new Error('boom')) : Promise.resolve({ key: d.key, nodes: [], edges: [] } as Layout)
    }
    return { runs, run }
  }

  it('lays out once per signature, whatever the node data', async () => {
    const { runs, run } = fake()
    const { get, peek } = layoutCache(run)
    expect(peek(layoutSignature(sample()))).toBeUndefined()
    const first = get(sample())
    expect(first.layout).toBeUndefined()
    await first.promise
    expect(first.layout).toBeDefined()
    expect(peek(layoutSignature(sample()))).toBe(first)
    expect(get(edit((d) => (d.nodes[2].data.title = 'other')))).toBe(first)
    get(edit((d) => (d.nodes[2].width = 1)))
    expect(runs).toEqual(['dc:x', 'dc:x'])
  })

  it('keeps the most recently used layouts', () => {
    const { runs, run } = fake()
    const { get } = layoutCache(run, 2)
    const at = (key: string) => edit((d) => (d.key = key))
    get(at('1'))
    get(at('2'))
    get(at('1')) // 2 is now the oldest
    get(at('3'))
    get(at('1'))
    get(at('2'))
    expect(runs).toEqual(['1', '2', '3', '2'])
  })

  it('forgets failed layouts', async () => {
    const { runs, run } = fake()
    const { get } = layoutCache(run)
    const d = edit((d) => (d.key = 'fail'))
    await expect(get(d).promise).rejects.toThrow('boom')
    get(d)
    expect(runs).toEqual(['fail', 'fail'])
  })
})
