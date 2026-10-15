import ELK from 'elkjs/lib/elk.bundled.js'
import { expect, it } from 'vitest'
import type { GraphEdge, GraphNode, Model } from '../model/types'
import { contractDiagram, datacenterDiagram } from './build'
import { layoutDiagram } from './layout'

// A synthetic contract far larger than the demo: 240 datacenters in eight
// locations, 60 Cross Connects, and one datacenter with 400 servers.
function largeModel(): Model {
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const add = (p: Partial<GraphNode> & Pick<GraphNode, 'id' | 'kind' | 'name'>) =>
    nodes.set(p.id, { ips: [], macs: [], labels: {}, facts: [], terms: [], searchText: '', raw: null, ...p })
  add({ id: 'root', kind: 'contract', name: 'Contract' })
  const locations = ['de/fra', 'de/txl', 'es/vit', 'gb/lhr', 'fr/par', 'us/las', 'us/ewr', 'de/fra/2']
  for (let i = 0; i < 240; i++) {
    const dc = `dc${i}`
    add({ id: dc, kind: 'datacenter', name: `dc-${i}`, location: locations[i % 8], dcId: dc, parentId: 'root' })
    for (let l = 0; l < 3; l++) {
      add({ id: `${dc}:lan:${l}`, kind: 'lan', name: `lan${l}`, dcId: dc, parentId: dc, subtype: l === 0 ? 'public' : 'private' })
    }
    for (let s = 0; s < (i === 0 ? 400 : 5); s++) {
      add({ id: `${dc}-s${s}`, kind: 'server', name: `web-${s}`, dcId: dc, parentId: dc })
      edges.push({ kind: 'member', from: `${dc}-s${s}`, to: `${dc}:lan:${1 + (s % 2)}` })
    }
  }
  for (let p = 0; p < 60; p++) {
    add({ id: `pcc${p}`, kind: 'pcc', name: `pcc-${p}`, parentId: 'root' })
    // Peers in the same location: datacenters i, i+8, i+16, …
    for (let j = 0; j < 2 + (p % 4); j++) edges.push({ kind: 'cross-connect', from: `dc${(p * 3 + j * 8) % 240}:lan:2`, to: `pcc${p}` })
  }
  const children = new Map<string, string[]>()
  const edgesByNode = new Map<string, GraphEdge[]>()
  for (const n of nodes.values()) if (n.parentId) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n.id])
  for (const e of edges) for (const id of [e.from, e.to]) edgesByNode.set(id, [...(edgesByNode.get(id) ?? []), e])
  return { rootId: 'root', nodes, edges, children, edgesByNode, coverageIssues: [], warnings: [] } as unknown as Model
}

it('lays out large contracts', async () => {
  const model = largeModel()
  const elk = new ELK()

  const contract = await layoutDiagram(contractDiagram(model), elk)
  expect(contract.nodes.filter((n) => n.type === 'dc')).toHaveLength(240)
  expect(contract.nodes.filter((n) => n.type === 'group')).toHaveLength(8)
  const top = contract.nodes.filter((n) => !n.parent)
  const width = Math.max(...top.map((n) => n.x + n.width))
  const height = Math.max(...top.map((n) => n.y + n.height))
  // Locations are packed into a roughly screen-shaped area, not one long row.
  expect(width / height).toBeGreaterThan(0.5)
  expect(width / height).toBeLessThan(4)

  // 400 servers on the same LANs collapse into two packed groups.
  const big = await layoutDiagram(datacenterDiagram(model, 'dc0'), elk)
  const groups = big.nodes.filter((n) => n.type === 'group')
  expect(groups.map((g) => g.data.subtitle)).toEqual(['200 servers', '200 servers'])
  for (const g of groups) expect(g.width / g.height).toBeLessThan(4)
}, 60000)
