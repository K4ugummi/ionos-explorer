import { describe, expect, it } from 'vitest'
import { fixtureModel } from '../test/fixture'
import type { GraphNode, Model } from '../model/types'
import { parseIpList } from './ipList'

const named = (m: Model, name: string) => [...m.nodes.values()].find((n) => n.name === name)!
const nicsOf = (m: Model, s: GraphNode) =>
  m.children
    .get(s.id)!
    .map((id) => m.nodes.get(id)!)
    .filter((n) => n.kind === 'nic')

describe('pasted IP corrections', async () => {
  const m = await fixtureModel()
  const fw = named(m, 'dr-fw-01')
  const app = nicsOf(m, fw).find((n) => n.name === 'nic-app')!
  const single = [...m.nodes.values()].find((n) => n.kind === 'server' && nicsOf(m, n).length === 1)!

  it('finds the NIC by server and LAN, MAC, or NIC id', () => {
    const lines = parseIpList(
      m,
      [
        '# server, LAN, IP',
        'dr-fw-01, app, 10.9.9.9, changed in the VM',
        `${app.macs[0].toUpperCase().replaceAll(':', '-')}\t10.9.9.10`,
        `${app.id} 10.9.9.11 10.9.9.12`,
        `${single.name}; 10.9.9.13/24`,
        '',
      ].join('\n'),
    )
    expect(lines.map((l) => l.error)).toEqual([undefined, undefined, undefined, undefined])
    expect(lines.map((l) => l.fix!.nic)).toEqual([app.id, app.id, app.id, nicsOf(m, single)[0].id])
    expect(lines[0].fix).toMatchObject({ ips: ['10.9.9.9'], note: 'changed in the VM' })
    expect(lines[2].fix!.ips).toEqual(['10.9.9.11', '10.9.9.12'])
    expect(lines[3].fix!.ips).toEqual(['10.9.9.13'])
    const dc = m.nodes.get(fw.dcId!)!.name
    expect(parseIpList(m, `${dc}/dr-fw-01, APP, 10.9.9.9`)[0].fix?.nic).toBe(app.id)
  })

  it('explains lines it cannot use', () => {
    const errors = parseIpList(
      m,
      ['dr-fw-01, 10.9.9.9', 'dr-fw-01, nope, 10.9.9.9', 'no-such-vm, 10.9.9.9', 'dr-fw-01, app', '02:00:00:00:00:00, 10.9.9.9'].join('\n'),
    ).map((l) => l.error)
    expect(errors[0]).toMatch(/has 2 NICs. Add the LAN \(internet, app\)/)
    expect(errors[1]).toMatch(/no NIC in “nope”/)
    expect(errors[2]).toMatch(/No server or NIC “no-such-vm”/)
    expect(errors[3]).toMatch(/No IP address/)
    expect(errors[4]).toMatch(/No NIC with MAC/)
  })

  it('asks for the datacenter when a server name is used twice', () => {
    const twin: GraphNode = { ...fw, id: 'twin', dcId: m.nodes.get(single.dcId!)!.id }
    const nodes = new Map(m.nodes).set('twin', twin)
    const error = parseIpList({ ...m, nodes }, 'dr-fw-01, app, 10.9.9.9')[0].error
    expect(error).toMatch(/2 servers are called “dr-fw-01”.*datacenter\/server/)
  })
})
