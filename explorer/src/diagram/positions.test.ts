import ELK from 'elkjs/lib/elk.bundled.js'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyAnnotations, parse } from '../annotations/annotations'
import type { Model } from '../model/types'
import { fixtureModel } from '../test/fixture'
import { contractDiagram, datacenterDiagram } from './build'
import { handles, toFlow } from './flow'
import { absolutePositions, layoutDiagram, layoutSignature, withData } from './layout'
import { applyPositions, movable, movingWith, offsetTo, padding, snapToGrid, type Offset } from './positions'
import type { DiagramNode, Layout } from './types'

const named = (m: Model, name: string) => [...m.nodes.values()].find((n) => n.name === name)!
const at = (x: number, y: number, width = 0, height = 0) => ({ x, y, width, height })

// A location with two cards and a line between them, a card outside it, and a packed group.
function sample(): Layout {
  return {
    key: 'contract',
    nodes: [
      {
        id: 'loc',
        type: 'group',
        layout: { 'elk.padding': '[top=40,left=16,bottom=16,right=16]' },
        data: { title: 'de/fra' },
        ...at(0, 0, 592, 168),
      },
      { id: 'a', type: 'dc', parent: 'loc', ref: 'a', data: { title: 'a' }, ...at(16, 40, 260, 112) },
      { id: 'b', type: 'dc', parent: 'loc', ref: 'b', data: { title: 'b' }, ...at(316, 40, 260, 112) },
      { id: 'c', type: 'dc', ref: 'c', data: { title: 'c' }, ...at(700, 40, 260, 112) },
      { id: 'p', type: 'group', layout: { 'elk.algorithm': 'rectpacking' }, data: { title: 'outside' }, ...at(0, 300, 230, 70) },
      { id: 'm', type: 'external', parent: 'p', ref: 'm', data: { title: 'site' }, ...at(10, 10, 210, 52) },
    ],
    edges: [
      {
        id: 'a-b',
        source: 'a',
        target: 'b',
        kind: 'cross-connect',
        points: [
          { x: 276, y: 96 },
          { x: 316, y: 96 },
        ],
      },
      {
        id: 'b-c',
        source: 'b',
        target: 'c',
        kind: 'tunnel',
        points: [
          { x: 576, y: 96 },
          { x: 700, y: 96 },
        ],
      },
      { id: 'a-m', source: 'a', target: 'm', kind: 'manual' },
    ],
  }
}

const offsets = (o: Record<string, Offset>) => new Map(Object.entries(o))

describe('applyPositions', () => {
  it('moves exactly the given boxes and drops the routes of their lines', () => {
    const l = sample()
    const moved = applyPositions(l, offsets({ c: { dx: 40, dy: 200 } }))
    const [before, after] = [absolutePositions(l), absolutePositions(moved)]
    for (const n of l.nodes) {
      const [b, a] = [before.get(n.id)!, after.get(n.id)!]
      expect([a.x - b.x, a.y - b.y, a.width - b.width, a.height - b.height], n.id).toEqual(n.id === 'c' ? [40, 200, 0, 0] : [0, 0, 0, 0])
    }
    const edges = new Map(moved.edges.map((e) => [e.id, e]))
    expect(edges.get('b-c')!.points).toBeUndefined()
    expect(edges.get('b-c')!.moved).toBe(true)
    // Untouched lines keep their route (the same objects), lines without one stay free.
    expect(edges.get('a-b')).toBe(l.edges[0])
    expect(edges.get('a-m')).toBe(l.edges[2])
    // The input layout is not changed.
    expect(sample()).toEqual(l)
  })

  it('takes a group’s contents along and shifts the routes inside it', () => {
    const moved = applyPositions(sample(), offsets({ loc: { dx: -100, dy: 50 } }))
    const abs = absolutePositions(moved)
    expect(abs.get('loc')).toEqual(at(-100, 50, 592, 168))
    expect(abs.get('a')).toEqual(at(-84, 90, 260, 112))
    expect(abs.get('b')).toEqual(at(216, 90, 260, 112))
    // Relative to the group, its cards stay where they were.
    expect(moved.nodes.find((n) => n.id === 'a')).toMatchObject({ x: 16, y: 40 })
    const edges = new Map(moved.edges.map((e) => [e.id, e]))
    expect(edges.get('a-b')!.points).toEqual([
      { x: 176, y: 146 },
      { x: 216, y: 146 },
    ])
    expect(edges.get('b-c')!.points).toBeUndefined()
  })

  it('draws a group around its contents when a box in it moves', () => {
    // b below a: the location gets narrower and taller, its padding stays.
    const moved = applyPositions(sample(), offsets({ b: { dx: -300, dy: 150 } }))
    const abs = absolutePositions(moved)
    expect(abs.get('b')).toEqual(at(16, 190, 260, 112))
    expect(abs.get('loc')).toEqual(at(0, 0, 16 + 260 + 16, 40 + 262 + 16))
    expect(moved.edges.find((e) => e.id === 'a-b')!.points).toBeUndefined()
    // Out to the left and up: the group grows that way, the other card stays put.
    const out = absolutePositions(applyPositions(sample(), offsets({ a: { dx: -200, dy: -100 } })))
    expect(out.get('loc')).toEqual(at(-200, -100, 592 + 200, 168 + 100))
    expect(out.get('b')).toEqual(at(316, 40, 260, 112))
    // Nested offsets add up: a card moved inside a moved location.
    const both = absolutePositions(applyPositions(sample(), offsets({ loc: { dx: 10, dy: 10 }, b: { dx: 0, dy: 100 } })))
    expect(both.get('a')).toEqual(at(26, 50, 260, 112))
    expect(both.get('b')).toEqual(at(326, 150, 260, 112))
    expect(both.get('loc')).toEqual(at(10, 10, 592, 168 + 100))
  })

  it('ignores boxes it does not have or may not move', () => {
    const l = sample()
    // m is in a packed group; "gone" was a box in an earlier snapshot; zero offsets are nothing.
    expect(applyPositions(l, offsets({ m: { dx: 50, dy: 50 }, gone: { dx: 10, dy: 10 }, a: { dx: 0, dy: 0 } }))).toBe(l)
    expect([...movable(l.nodes)].sort()).toEqual(['a', 'b', 'c', 'loc', 'p'])
  })

  it('finds the offset that puts a box where it was dropped', () => {
    const l = sample()
    for (const [id, start] of [
      ['c', {}],
      ['b', {}],
      ['loc', { a: { dx: -200, dy: -100 } }], // a group drawn larger than its layout
      ['a', { loc: { dx: 30, dy: 0 }, a: { dx: 5, dy: 5 } }],
    ] as [string, Record<string, Offset>][]) {
      const o = offsets(start)
      const drawn = absolutePositions(applyPositions(l, o))
      const target = { x: drawn.get(id)!.x + 123, y: drawn.get(id)!.y - 45 }
      const next = new Map(o).set(id, offsetTo(drawn, o, id, target))
      expect(absolutePositions(applyPositions(l, next)).get(id), id).toMatchObject(target)
    }
  })

  it('reads ELK padding', () => {
    expect(padding('[top=40,left=16,bottom=16,right=16]')).toEqual({ top: 40, left: 16, bottom: 16, right: 16 })
    expect(padding(undefined)).toEqual({ top: 12, left: 12, bottom: 12, right: 12 })
  })
})

describe('own positions on the demo', async () => {
  const m0 = await fixtureModel()
  const demo = parse(readFileSync(new URL('../../../fixtures/demo-annotations.json', import.meta.url), 'utf8')).annotations
  const m = applyAnnotations(m0, demo).model
  const contract = contractDiagram(m)
  const fra = named(m, 'fra-prod-core').id
  const dc = datacenterDiagram(m, fra)
  const [cl, dl] = await Promise.all([layoutDiagram(contract, new ELK()), layoutDiagram(dc, new ELK())])

  it('lets cards, hubs, locations and top-level boxes move, not members of packed groups', () => {
    const can = movable(cl.nodes)
    const type = (id: string) => cl.nodes.find((n) => n.id === id)!
    for (const n of cl.nodes) {
      const packed = !!n.parent && type(n.parent).layout?.['elk.algorithm'] === 'rectpacking'
      expect(can.has(n.id), n.id).toBe(!packed)
    }
    expect(can.has(fra)).toBe(true)
    expect(cl.nodes.some((n) => n.parent === 'group:external' && !can.has(n.id))).toBe(true)
    const inDc = movable(dl.nodes)
    expect(dl.nodes.filter((n) => !inDc.has(n.id)).every((n) => n.type === 'member' || n.type === 'more')).toBe(true)
    expect(dl.nodes.filter((n) => n.type === 'member').length).toBeGreaterThan(0)
    expect(dl.nodes.filter((n) => n.type === 'group').every((n) => inDc.has(n.id))).toBe(true)
  })

  it('moves a datacenter card in its location; its lines lose their route, the others keep theirs', () => {
    const moved = applyPositions(cl, offsets({ [fra]: { dx: 0, dy: 400 } }))
    const [before, after] = [absolutePositions(cl), absolutePositions(moved)]
    const loc = cl.nodes.find((n) => n.id === fra)!.parent!
    for (const n of cl.nodes) {
      const [b, a] = [before.get(n.id)!, after.get(n.id)!]
      if (n.id === fra) expect([a.x - b.x, a.y - b.y]).toEqual([0, 400])
      else if (n.id === loc) expect(a.y + a.height).toBeGreaterThanOrEqual(after.get(fra)!.y + after.get(fra)!.height + 16)
      else expect(a, n.id).toEqual(b)
    }
    for (const e of moved.edges) {
      const old = cl.edges.find((x) => x.id === e.id)!
      if (e.source === fra || e.target === fra) expect(e.points, e.id).toBeUndefined()
      else if (cl.nodes.some((n) => n.id === e.source)) expect(e.points, e.id).toEqual(old.points)
    }
    expect(moved.edges.filter((e) => e.moved).length).toBeGreaterThan(0)
  })

  it('moves a server group with its members; a member alone stays', () => {
    const group = dl.nodes.find((n) => n.type === 'group' && dl.nodes.some((c) => c.parent === n.id && c.type === 'member'))!
    const member = dl.nodes.find((n) => n.parent === group.id)!
    const moved = absolutePositions(applyPositions(dl, offsets({ [group.id]: { dx: 500, dy: 0 } })))
    const before = absolutePositions(dl)
    expect(moved.get(member.id)!.x - before.get(member.id)!.x).toBe(500)
    expect(applyPositions(dl, offsets({ [member.id]: { dx: 500, dy: 0 } }))).toBe(dl)
  })

  it('is applied after the layout: no part of the layout signature, and on cached layouts', () => {
    // Offsets live outside the diagram; a rebuilt diagram reuses the layout and gets them on top.
    const again = contractDiagram(m)
    expect(layoutSignature(again)).toBe(layoutSignature(contract))
    const placed = applyPositions(withData(cl, again), offsets({ [fra]: { dx: 10, dy: 20 } }))
    const flow = toFlow(placed, again, undefined, null, null, movable(placed.nodes))
    const card = flow.nodes.find((n) => n.id === fra)!
    expect(card.draggable).toBe(true)
    expect(card.position).toEqual({ x: cl.nodes.find((n) => n.id === fra)!.x + 10, y: cl.nodes.find((n) => n.id === fra)!.y + 20 })
    expect(flow.nodes.filter((n) => n.draggable).length).toBe(movable(placed.nodes).size)
    // Without the set (focus and path views) nothing can be dragged.
    expect(toFlow(placed, again, undefined, null).nodes.some((n) => n.draggable)).toBe(false)
    // Lines that lost their route leave by the sides that face each other.
    const free = flow.edges.filter((e) => e.data?.moved)
    expect(free.length).toBeGreaterThan(0)
    expect(free.every((e) => !e.data?.points)).toBe(true)
  })
})

describe('handles', () => {
  const box = (x: number, y: number) => at(x, y, 100, 50)
  it('joins boxes top to bottom, and side by side only for moved lines', () => {
    expect(handles(box(0, 0), box(0, 200))).toEqual(['bottom', 'top'])
    expect(handles(box(0, 200), box(0, 0))).toEqual(['top-out', 'bottom-in'])
    // Side by side: unmoved lines keep the old rule (down), moved ones go sideways.
    expect(handles(box(0, 0), box(300, 10))).toEqual(['bottom', 'top'])
    expect(handles(box(0, 0), box(300, 10), true)).toEqual(['right-out', 'left-in'])
    expect(handles(box(300, 10), box(0, 0), true)).toEqual(['left-out', 'right-in'])
    // A wider vertical gap wins over a narrow horizontal one.
    expect(handles(box(0, 0), box(120, 400), true)).toEqual(['bottom', 'top'])
    expect(handles(box(0, 400), box(120, 0), true)).toEqual(['top-out', 'bottom-in'])
    // Overlapping boxes: down.
    expect(handles(box(0, 0), box(10, 10), true)).toEqual(['bottom', 'top'])
  })
})

describe('snapping and moving several boxes', () => {
  const nodes = [
    { id: 'loc', type: 'group' },
    { id: 'a', type: 'dc', parent: 'loc' },
    { id: 'b', type: 'dc', parent: 'loc' },
    { id: 'c', type: 'resource' },
  ] as DiagramNode[]

  it('snaps to the dots of the background', () => {
    expect(snapToGrid({ x: 29, y: -11 })).toEqual({ x: 20, y: -20 })
    expect(snapToGrid({ x: 30, y: 9.9 }, 10)).toEqual({ x: 30, y: 10 })
  })

  it('moves the held box alone unless it is one of several picked', () => {
    expect(movingWith('a', new Set(), nodes)).toEqual(new Set(['a']))
    expect(movingWith('a', new Set(['a']), nodes)).toEqual(new Set(['a']))
    expect(movingWith('a', new Set(['b', 'c']), nodes)).toEqual(new Set(['a']))
    expect(movingWith('a', new Set(['a', 'c']), nodes)).toEqual(new Set(['a', 'c']))
    // A box inside a picked group goes along with the group.
    expect(movingWith('loc', new Set(['loc', 'a', 'c']), nodes)).toEqual(new Set(['loc', 'c']))
    // Picked boxes this view does not have are left out.
    expect(movingWith('a', new Set(['a', 'gone']), nodes)).toEqual(new Set(['a']))
  })
})
