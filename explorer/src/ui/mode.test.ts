import { describe, expect, it } from 'vitest'
import type { Model } from '../model/types'
import { fixtureModel } from '../test/fixture'
import { modeKey, modeParams, parseMode } from './mode'

const id = (m: Model, name: string, kind?: string) =>
  [...m.nodes.values()].find((n) => n.name === name && (kind ? n.kind === kind : n.kind !== 'datacenter'))!.id

describe('diagram modes in the hash', async () => {
  const m = await fixtureModel()
  const [fw, pg] = [id(m, 'fra-core-fw-01'), id(m, 'pg-orders-prod')]

  it('reads focus and path views, a path before a focus', () => {
    expect(parseMode({ focus: fw }, m)).toEqual({ kind: 'focus', id: fw, hops: 2 })
    expect(parseMode({ focus: fw, hops: '3' }, m)).toEqual({ kind: 'focus', id: fw, hops: 3 })
    expect(parseMode({ path: `${fw},${pg}`, hops: '1' }, m)).toEqual({ kind: 'path', from: fw, to: pg, hops: 1 })
    expect(parseMode({ path: `${fw},${pg}`, focus: fw }, m)?.kind).toBe('path')
    expect(parseMode({}, m)).toBeUndefined()
  })

  it('ignores what does not name the network, and hops out of range', () => {
    expect(parseMode({ focus: 'nope' }, m)).toBeUndefined()
    expect(parseMode({ focus: id(m, 'fra-prod-core', 'datacenter') }, m)).toBeUndefined()
    expect(parseMode({ path: fw }, m)).toBeUndefined()
    expect(parseMode({ path: `${fw},${pg},${fw}` }, m)).toBeUndefined()
    expect(parseMode({ path: `${fw},${fw}` }, m)).toBeUndefined()
    // A NIC of the same server is the same place.
    const nic = (m.children.get(fw) ?? []).find((c) => m.nodes.get(c)!.kind === 'nic')!
    expect(parseMode({ path: `${fw},${nic}` }, m)).toBeUndefined()
    for (const hops of ['0', '4', 'x', '-1', '']) expect(parseMode({ focus: fw, hops }, m)?.hops).toBe(2)
  })

  it('writes them back, and nothing for no mode', () => {
    for (const mode of [
      { kind: 'focus', id: fw, hops: 2 },
      { kind: 'focus', id: fw, hops: 3 },
      { kind: 'path', from: fw, to: pg, hops: 1 },
    ] as const) {
      const p = modeParams(mode)
      expect(parseMode(p, m)).toEqual(mode)
    }
    expect(modeParams({ kind: 'focus', id: fw, hops: 2 }).hops).toBeUndefined()
    expect(Object.values(modeParams())).toEqual([undefined, undefined, undefined])
    expect(modeKey({ kind: 'path', from: fw, to: pg, hops: 2 })).not.toBe(modeKey({ kind: 'path', from: pg, to: fw, hops: 2 }))
  })
})
