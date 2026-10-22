import { describe, expect, it } from 'vitest'
import { fixtureModel } from '../test/fixture'
import { datacenterDiagram } from './build'
import { expandable, MAX_VIEWS, NOTHING_OPENED, parseOpened, serializeOpened, withView } from './opened'

const named = (m: Awaited<ReturnType<typeof fixtureModel>>, name: string) => [...m.nodes.values()].find((n) => n.name === name)!

describe('opened groups', () => {
  it('round-trip, leave out empty views and junk', () => {
    const o = withView(withView(NOTHING_OPENED, 'dc:a', new Set(['grp:web', 'lans:fw'])), 'dc:b', new Set())
    expect(serializeOpened(o)).toBe('{"dc:a":["grp:web","lans:fw"]}')
    expect(parseOpened(serializeOpened(o))).toEqual(new Map([['dc:a', new Set(['grp:web', 'lans:fw'])]]))
    expect(parseOpened('{"dc:a":["x",3],"dc:b":"nope","dc:c":[]}')).toEqual(new Map([['dc:a', new Set(['x'])]]))
    expect(parseOpened('[1]')).toBe(NOTHING_OPENED)
    expect(parseOpened('not json')).toBe(NOTHING_OPENED)
    expect(parseOpened(null)).toBe(NOTHING_OPENED)
  })

  it('forget the views opened longest ago', () => {
    let o = NOTHING_OPENED
    for (let i = 0; i <= MAX_VIEWS; i++) o = withView(o, `dc:${i}`, new Set(['g']))
    o = withView(o, 'dc:0', new Set(['g'])) // used again: now the most recent
    const kept = Object.keys(JSON.parse(serializeOpened(o)) as object)
    expect(kept).toHaveLength(MAX_VIEWS)
    expect(kept).toContain('dc:0')
    expect(kept).not.toContain('dc:1')
  })
})

describe('expand and collapse all', async () => {
  const m = await fixtureModel()
  const dc = named(m, 'fra-prod-core').id

  it('opens every collapsed group and folded router, and closes them again', () => {
    const closed = datacenterDiagram(m, dc)
    const all = expandable(closed)
    expect(all.closed.length).toBeGreaterThan(0)
    expect(all.open).toEqual([])
    const open = datacenterDiagram(m, dc, { expanded: new Set(all.closed) })
    expect(open.nodes.some((n) => n.type === 'more')).toBe(false)
    expect(expandable(open).closed).toEqual([])
    expect(expandable(open).open.sort()).toEqual([...all.closed].sort())
  })
})
