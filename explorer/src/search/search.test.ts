import { describe, expect, it } from 'vitest'
import { fixtureModel } from '../test/fixture'
import { parseQuery, search } from './search'

describe('parseQuery', () => {
  it('splits filters, phrases, negation and keeps unknown keys as text', () => {
    expect(parseQuery('type:Cube "web 01" -kind:nic 02:01:ab urn:x')).toEqual([
      { key: 'type', value: 'cube', negate: false },
      { value: 'web 01', negate: false },
      { key: 'kind', value: 'nic', negate: true },
      { value: '02:01:ab', negate: false },
      { value: 'urn:x', negate: false },
    ])
  })
})

describe('search on the demo fixture', async () => {
  const m = await fixtureModel()
  const names = (q: string) => search(m, q).hits.map((h) => h.node.name)

  it('ranks exact name matches first', () => {
    expect(names('fra-core-fw-01')[0]).toBe('fra-core-fw-01')
    expect(names('fra-core-fw').slice(0, 2)).toEqual(['fra-core-fw-01', 'fra-core-fw-02'])
  })

  it('filters servers by type, with DCD aliases', () => {
    expect(search(m, 'type:cube').hits).toHaveLength(23)
    expect(search(m, 'type:dedicated').hits).toHaveLength(22)
    expect(search(m, 'type:gpu').hits.map((h) => h.node.name)).toEqual(['gpu-trainer-01'])
  })

  it('searches across all datacenters by LAN name', () => {
    const lans = search(m, 'kind:lan app').hits.map((h) => m.nodes.get(h.node.dcId!)!.name)
    expect(lans.length).toBeGreaterThanOrEqual(5)
    expect(new Set(lans).size).toBe(lans.length)
  })

  it('finds resources by IP, MAC and globs', () => {
    const vip = m.nodes.get([...m.nodes.values()].find((n) => n.kind === 'lan' && n.ips.length)!.id)!.ips[0]
    // A failover IP lives on the LAN, every member's NIC, and its IP block.
    expect(new Set(search(m, vip).hits.map((h) => h.node.kind))).toEqual(new Set(['lan', 'server', 'nic', 'ipblock']))
    const nic = [...m.nodes.values()].find((n) => n.kind === 'nic')!
    expect(names(nic.macs[0])).toContain(nic.name)
    expect(search(m, 'ip:203.0.113.*').hits.length).toBeGreaterThan(5)
  })

  it('combines dc, label, state filters and negation', () => {
    expect(names('dc:fra-lab state:shutoff')).toEqual(['lab-old-notebook-01'])
    expect(search(m, 'label:role=vpn').hits).toHaveLength(3)
    expect(search(m, 'kind:server dc:txl-dev -type:cube').hits).toHaveLength(2)
  })

  it('counts kinds regardless of kind filters', () => {
    const r = search(m, 'kind:server app')
    expect(r.hits.every((h) => h.node.kind === 'server')).toBe(true)
    expect(r.kindCounts.get('nic')).toBeGreaterThan(0)
  })

  it('returns nothing for an empty query', () => {
    expect(search(m, '   ').hits).toEqual([])
  })
})
