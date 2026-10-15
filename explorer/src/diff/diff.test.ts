import { describe, expect, it } from 'vitest'
import { fixtureModel, previousFixtureModel } from '../test/fixture'
import { compareModels, countsByDc } from './diff'

describe('comparing the demo with its state two weeks earlier', async () => {
  const [older, newer] = await Promise.all([previousFixtureModel(), fixtureModel()])
  const diff = compareModels(older, newer)
  const of = (name: string) => diff.changes.find((c) => c.node.name === name)
  const lines = (name: string) => of(name)?.fields.map((f) => `${f.field}: ${f.before ?? '–'} → ${f.after ?? '–'}`)

  it('finds exactly the edits made in history.go', () => {
    expect(diff.changes.filter((c) => c.node.kind === 'server').map((c) => `${c.type} ${c.node.name}`)).toEqual(
      expect.arrayContaining([
        'added fra-core-hub-01',
        'removed fra-core-legacy-01',
        'changed fra-core-api-01',
        'changed lab-old-notebook-01',
        'changed txl-core-fw-01',
        'changed lhr-edge-gw-01',
        'changed erp-app-01',
      ]),
    )
    expect(diff.changes.filter((c) => c.node.kind === 'server')).toHaveLength(7)
    expect(lines('fra-core-api-01')).toEqual(['Cores: 2 → 4'])
    expect(lines('lab-old-notebook-01')).toEqual(['State: RUNNING → SHUTOFF', 'VM state: RUNNING → SHUTOFF'])
    expect(lines('erp-app-01')).toEqual(['Label env: test → prod'])
    expect(lines('lhr-edge-gw-01')).toEqual(['Connection: – → secured by Security Group sg-edge-ipsec'])
    expect(lines('txl-core-fw-01')).toEqual([expect.stringMatching(/^IPs: .*\.250, .* → .*\.11, /)])
    // Its NIC reports the same change in detail.
    const nic = diff.changes.find((c) => c.node.kind === 'nic' && c.parentName === 'txl-core-fw-01')!
    expect(nic.fields.map((f) => f.field)).toEqual(['IPs'])
  })

  it('reports child resources with their context', () => {
    const rule = diff.changes.find((c) => c.node.kind === 'nic' && c.parentName === 'bastion-01')!
    expect(rule.type).toBe('changed')
    expect(rule.fields).toEqual([
      { field: 'Firewall rules', before: expect.stringContaining('TCP 3389'), after: expect.not.stringContaining('3389') },
    ])
    expect(rule.dcName).toBe('fra-mgmt')
    // New and removed volumes and NICs come with their servers.
    expect(
      diff.changes
        .filter((c) => c.type === 'added')
        .map((c) => c.node.kind)
        .sort(),
    ).toEqual(['nic', 'nic', 'nic', 'nic', 'server', 'volume'])
  })

  it('reports nothing for an identical snapshot, and counts per datacenter', () => {
    expect(compareModels(newer, newer).changes).toEqual([])
    const core = [...newer.nodes.values()].find((n) => n.name === 'fra-prod-core')!
    expect(countsByDc(diff).get(core.id)).toMatchObject({ added: 6, removed: expect.any(Number), changed: expect.any(Number) })
    expect(diff.counts.added + diff.counts.removed + diff.counts.changed).toBe(diff.changes.length)
  })
})
