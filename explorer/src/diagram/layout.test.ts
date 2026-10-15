import ELK from 'elkjs/lib/elk.bundled.js'
import { describe, expect, it } from 'vitest'
import { applyAnnotations, EMPTY } from '../annotations/annotations'
import { compareModels, markChanges } from '../diff/diff'
import { fixtureModel, previousFixtureModel } from '../test/fixture'
import { contractDiagram, datacenterDiagram } from './build'
import { layoutCache, layoutDiagram, layoutSignature, withData } from './layout'
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
