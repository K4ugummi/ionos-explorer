import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fixtureModel } from '../test/fixture'
import type { Model } from '../model/types'
import { search } from '../search/search'
import {
  addLink,
  addSite,
  applyAnnotations,
  EMPTY,
  isEmpty,
  loadStored,
  merge,
  normalizeIP,
  parse,
  positionsOf,
  removeIpFix,
  removeSite,
  resetPositions,
  saveStored,
  serialize,
  setIpFix,
  setPosition,
  siteNodeId,
} from './annotations'

const named = (m: Model, name: string) => [...m.nodes.values()].find((n) => n.name === name)!

describe('annotations', async () => {
  const m = await fixtureModel()
  const fraVpn = named(m, 'fra-core-vpn-01').id
  const txlVpn = named(m, 'txl-core-vpn-01').id

  it('adds manual links as edges and keeps unknown ends aside', () => {
    let a = addLink(EMPTY, { from: fraVpn, to: txlVpn, label: 'IPsec' })
    a = addLink(a, { from: fraVpn, to: 'deleted-server', label: 'GRE' })
    const { model, dangling } = applyAnnotations(m, a)
    const manual = model.edgesByNode.get(fraVpn)!.filter((e) => e.kind === 'manual')
    expect(manual.map((e) => [model.nodes.get(e.to)!.name, e.label])).toEqual([['txl-core-vpn-01', 'IPsec']])
    expect(dangling.map((l) => l.to)).toEqual(['deleted-server'])
    // The snapshot model stays untouched.
    expect(m.edges.some((e) => e.kind === 'manual')).toBe(false)
    expect(applyAnnotations(m, EMPTY).model).toBe(m)
  })

  it('lets a site take over VPN tunnels to its hosts', () => {
    const [a, site] = addSite(EMPTY, { name: 'Head office', hosts: ['192.0.2.10'], note: 'Frankfurt HQ' })
    const { model } = applyAnnotations(m, a)
    const node = model.nodes.get(siteNodeId(site))!
    expect([node.kind, node.subtype, node.ips]).toEqual(['external', 'Site', ['192.0.2.10']])
    expect(model.nodes.has('ext:192.0.2.10')).toBe(false)
    const hq = named(model, 'hq-office')
    expect(model.edgesByNode.get(hq.id)!.find((e) => e.kind === 'tunnel')!.to).toBe(node.id)
    expect(model.children.get(model.rootId)).toContain(node.id)
    expect(node.searchText).toContain('frankfurt hq')
    // A link made to the raw host before the site existed now ends at the site.
    const linked = applyAnnotations(m, addLink(a, { from: fraVpn, to: 'ext:192.0.2.10' })).model
    expect(linked.edges.find((e) => e.kind === 'manual')!.to).toBe(node.id)
  })

  it('round-trips through a file and rejects garbage', () => {
    const [withSite, site] = addSite(EMPTY, { name: 'DC Paris', hosts: [] })
    const a = addLink(withSite, { from: fraVpn, to: siteNodeId(site), label: 'MPLS', note: 'carrier X' })
    const back = parse(serialize(a, 31812345))
    expect(back).toEqual({ annotations: a, contract: 31812345 })
    expect(() => parse('nope')).toThrow('Not a JSON file.')
    expect(() => parse('{"format":"something-else"}')).toThrow(/Not an IONOS Explorer/)
    expect(() => parse({ format: 'ionos-explorer-annotations', version: 2 })).toThrow(/version 2/)
    const cleaned = parse({
      format: 'ionos-explorer-annotations',
      version: 1,
      sites: [{ id: 'ok', name: 'x', hosts: ['1.2.3.4', 5] }, { id: '../bad', name: 'y' }, { id: 'noname' }],
      links: [
        { id: 'l1', from: 'a', to: 'a' },
        { id: 'l2', from: 'a b', to: 'c' },
        { id: 'l3', from: 'a', to: 'c', extra: 1 },
      ],
    }).annotations
    expect(cleaned.sites.map((s) => [s.id, s.hosts])).toEqual([['ok', ['1.2.3.4']]])
    expect(cleaned.links.map((l) => l.id)).toEqual(['l3'])
  })

  it('merges by id and removes sites with their links', () => {
    const [a, site] = addSite(EMPTY, { name: 'A', hosts: [] })
    const linked = addLink(a, { from: fraVpn, to: siteNodeId(site) })
    const renamed = { ...linked, sites: [{ ...site, name: 'B' }], links: [] }
    expect(merge(linked, renamed).sites.map((s) => s.name)).toEqual(['B'])
    expect(merge(linked, renamed).links).toHaveLength(1)
    expect(removeSite(linked, site.id)).toEqual(EMPTY)
  })

  it('ships demo links that fit the demo snapshot', () => {
    const text = readFileSync(new URL('../../../fixtures/demo-annotations.json', import.meta.url), 'utf8')
    const { annotations, contract } = parse(text)
    expect(contract).toBe(m.manifest.contract?.number)
    const { model, dangling } = applyAnnotations(m, annotations)
    expect(dangling).toEqual([])
    const names = model.edges
      .filter((e) => e.kind === 'manual')
      .map((e) => `${model.nodes.get(e.from)!.name} ↔ ${model.nodes.get(e.to)!.name}`)
    expect(names).toEqual(['fra-core-vpn-01 ↔ txl-core-vpn-01', 'lhr-edge-gw-01 ↔ Head office'])
    const fixed = applyAnnotations(m, annotations)
    expect(fixed.staleIps).toEqual([])
    expect(search(fixed.model, 'kind:nic is:corrected').hits.map((h) => fixed.model.nodes.get(h.node.parentId!)!.name)).toEqual([
      'dr-fw-01',
    ])
  })
})

describe('IP corrections', async () => {
  const m = await fixtureModel()
  const server = named(m, 'dr-fw-01')
  const nics = m.children.get(server.id)!.map((id) => m.nodes.get(id)!)
  const app = nics.find((n) => n.name === 'nic-app')!
  const old = app.ips[0]

  it('shows the real IP everywhere and keeps the IONOS one', () => {
    const { model, staleIps } = applyAnnotations(m, setIpFix(EMPTY, { nic: app.id, ips: ['10.99.0.7'], note: 'checked in the VM' }))
    expect(staleIps).toEqual([])
    const nic = model.nodes.get(app.id)!
    expect([nic.ips, nic.ionosIps]).toEqual([['10.99.0.7'], [old]])
    expect(nic.facts.find((f) => f.label === 'IPs in IONOS')?.value).toBe(old)
    const srv = model.nodes.get(server.id)!
    expect(srv.ips).toContain('10.99.0.7')
    expect(srv.ips).not.toContain(old)
    expect(srv.ips[0]).toBe(server.ips[0]) // other NICs keep their place
    const member = model.edges.find((e) => e.kind === 'member' && e.from === server.id && e.label?.includes('10.99.0.7'))
    expect(member).toBeDefined()
    // Both addresses find it; the snapshot model is untouched.
    for (const q of ['ip:10.99.0.7', `ip:${old}`, '10.99.0.7', 'is:corrected']) {
      expect(
        search(model, q).hits.map((h) => h.node.id),
        q,
      ).toEqual(expect.arrayContaining([server.id, app.id]))
    }
    expect(m.nodes.get(app.id)!.ips).toEqual([old])
    expect(search(m, 'ip:10.99.0.7').hits).toEqual([])
  })

  it('keeps corrections for NICs that are gone, and removes them on request', () => {
    const a = setIpFix(setIpFix(EMPTY, { nic: app.id, ips: ['10.99.0.7'] }), { nic: 'gone-nic', ips: ['10.0.0.1'] })
    expect(applyAnnotations(m, a).staleIps.map((f) => f.nic)).toEqual(['gone-nic'])
    expect(setIpFix(a, { nic: app.id, ips: ['10.99.0.8'] }).ips.filter((f) => f.nic === app.id)).toHaveLength(1)
    expect(removeIpFix(removeIpFix(a, 'gone-nic'), app.id)).toEqual(EMPTY)
  })

  it('round-trips through files and drops what is not an IP', () => {
    const a = setIpFix(EMPTY, { nic: app.id, ips: ['10.99.0.7', 'fd00::7'], note: 'n' })
    expect(parse(serialize(a)).annotations).toEqual(a)
    const cleaned = parse({
      format: 'ionos-explorer-annotations',
      version: 1,
      ips: [
        { nic: 'n1', ips: ['10.0.0.1/24', '999.1.1.1', 'x', 7] },
        { nic: 'n2', ips: ['nope'] },
        { nic: '../n3', ips: ['10.0.0.3'] },
      ],
    }).annotations
    expect(cleaned.ips).toEqual([{ nic: 'n1', ips: ['10.0.0.1'], note: undefined }])
    // Older files without IP corrections still load.
    expect(parse({ format: 'ionos-explorer-annotations', version: 1, links: [] }).annotations.ips).toEqual([])
    expect(merge(a, setIpFix(EMPTY, { nic: app.id, ips: ['10.1.1.1'] })).ips).toEqual([{ nic: app.id, ips: ['10.1.1.1'] }])
  })

  it('normalizes addresses', () => {
    expect(['10.0.0.01', '10.0.0.5/24', ' FD00::1 ', '256.0.0.1', '10.0.0', 'abc'].map(normalizeIP)).toEqual([
      '10.0.0.1',
      '10.0.0.5',
      'fd00::1',
      undefined,
      undefined,
      undefined,
    ])
  })

  it('finds NICs whose IP IONOS does not assign', () => {
    const off = search(m, 'kind:nic dhcp:off').hits.map((h) => h.node)
    expect(off.length).toBeGreaterThan(0)
    expect(off.every((n) => n.dhcp === false)).toBe(true)
    expect(search(m, 'kind:server dhcp:off').hits.map((h) => h.node.name)).toContain('dr-fw-01')
    expect(search(m, 'kind:server dhcp:off').hits.map((h) => h.node.name)).not.toContain('bastion-01')
  })
})

describe('box positions', async () => {
  const m = await fixtureModel()
  const fra = named(m, 'fra-prod-core').id
  const moved = setPosition(setPosition(EMPTY, { view: 'contract', node: fra, dx: 120.4, dy: -40 }), {
    view: `dc:${fra}`,
    node: 'grp:fra-core-web|lan-a,lan-b',
    dx: 0,
    dy: 300,
  })

  it('stores offsets per view and box, rounded; moving back to 0, 0 forgets one', () => {
    expect(moved.positions).toEqual([
      { view: 'contract', node: fra, dx: 120, dy: -40 },
      { view: `dc:${fra}`, node: 'grp:fra-core-web|lan-a,lan-b', dx: 0, dy: 300 },
    ])
    expect(isEmpty(moved)).toBe(false)
    // Moving it again replaces the entry.
    expect(setPosition(moved, { view: 'contract', node: fra, dx: 5, dy: 5 }).positions.filter((p) => p.view === 'contract')).toEqual([
      { view: 'contract', node: fra, dx: 5, dy: 5 },
    ])
    expect(setPosition(moved, { view: 'contract', node: fra, dx: 0.3, dy: 0 }).positions).toHaveLength(1)
    expect([...positionsOf(moved.positions, 'contract')]).toEqual([[fra, { dx: 120, dy: -40 }]])
    expect(positionsOf(moved.positions, 'dc:other').size).toBe(0)
    expect(resetPositions(moved, 'contract').positions.map((p) => p.view)).toEqual([`dc:${fra}`])
    expect(resetPositions(moved)).toEqual(EMPTY)
  })

  it('leaves the model alone', () => {
    expect(applyAnnotations(m, moved).model).toBe(m)
  })

  it('round-trips through a file and drops junk; unknown views and boxes are kept', () => {
    const kept = setPosition(moved, { view: 'dc:not-in-this-snapshot', node: 'gone', dx: 1, dy: 2 })
    expect(parse(serialize(kept, 31812345)).annotations).toEqual(kept)
    const cleaned = parse({
      format: 'ionos-explorer-annotations',
      version: 1,
      positions: [
        { view: 'contract', node: 'loc:de/fra', dx: 10.6, dy: '5' },
        { view: 'contract', node: 'loc:de/fra', dx: 10.6, dy: -3.2 },
        { view: 'contract', node: 'a\nb', dx: 1, dy: 1 },
        { view: '', node: 'x', dx: 1, dy: 1 },
        { view: 'contract', node: 'x', dx: Infinity, dy: 1 },
        { view: 'contract', node: 'x', dx: 2e6, dy: 1 },
        { view: 'contract', node: 'x', dx: 0, dy: 0.2 },
        { view: 'contract', node: 'grp:Unattached volumes', dx: -1, dy: 0 },
        { view: 'contract', node: 'loc:de/fra', dx: 7, dy: 7 },
        null,
        'x',
      ],
    }).annotations
    // The last entry for a box wins.
    expect(cleaned.positions).toEqual([
      { view: 'contract', node: 'grp:Unattached volumes', dx: -1, dy: 0 },
      { view: 'contract', node: 'loc:de/fra', dx: 7, dy: 7 },
    ])
    // Files from before positions still load.
    expect(parse({ format: 'ionos-explorer-annotations', version: 1 }).annotations.positions).toEqual([])
    expect(parse({ format: 'ionos-explorer-annotations', version: 1, positions: { view: 'contract' } }).annotations.positions).toEqual([])
  })

  it('merges by view and box, the imported file winning', () => {
    const theirs = setPosition(EMPTY, { view: 'contract', node: fra, dx: -7, dy: 9 })
    const both = merge(moved, setPosition(theirs, { view: 'contract', node: 'loc:de/txl', dx: 1, dy: 1 }))
    expect(both.positions).toEqual([
      { view: 'contract', node: fra, dx: -7, dy: 9 },
      { view: `dc:${fra}`, node: 'grp:fra-core-web|lan-a,lan-b', dx: 0, dy: 300 },
      { view: 'contract', node: 'loc:de/txl', dx: 1, dy: 1 },
    ])
  })

  it('is kept in the browser even without links', () => {
    const store = new Map<string, string>()
    const fake = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    }
    const real = globalThis.localStorage
    Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true })
    try {
      saveStored('k', moved)
      expect(loadStored('k')).toEqual(moved)
      saveStored('k', resetPositions(moved))
      expect(store.has('k')).toBe(false)
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: real, configurable: true })
    }
  })
})
