import { describe, expect, it } from 'vitest'
import { search } from '../search/search'
import { fixtureModel } from '../test/fixture'
import { detect, IMAGE_RULES } from './appliances'
import type { Model } from './types'

const named = (m: Model, name: string) => [...m.nodes.values()].find((n) => n.name === name)!

describe('network appliances', async () => {
  const m = await fixtureModel()

  it('names the product when the image gives it away', () => {
    const vpn = named(m, 'fra-core-vpn-01').appliance!
    expect([vpn.title, vpn.confidence]).toEqual(['Cisco Catalyst 8000V', 'high'])
    expect(vpn.reasons[0]).toMatch(/cisco-c8000v-17\.12\.03a/)
    // Nothing in this name hints at a role: the image alone decides.
    const asa = named(m, 'lhr-edge-gw-01').appliance!
    expect([asa.title, asa.confidence]).toEqual(['Cisco ASAv', 'high'])
  })

  it('explains guesses from firewall rules and placement', () => {
    const fw = named(m, 'fra-core-fw-01').appliance!
    expect([fw.title, fw.confidence]).toEqual(['Likely firewall or VPN gateway', 'medium'])
    expect(fw.reasons.join(' ')).toMatch(/IKE \(UDP 500\/4500\).*public LAN internet.*failover IP/)
    expect(named(m, 'txl-core-vpn-01').appliance!.reasons.join(' ')).toMatch(/VPN tunnel txl-core of vpngw-mgmt/)
  })

  it('reads IPsec rules from Security Groups', () => {
    const reasons = named(m, 'lhr-edge-gw-01').appliance!.reasons.join(' ')
    expect(reasons).toMatch(/Security Group sg-edge-ipsec allows ESP and IKE \(UDP 500\/4500\)/)
    expect(reasons).not.toMatch(/Firewall rules allow/)
  })

  it('flags servers in many LANs, more firmly when their datacenter names a product', () => {
    const hub = named(m, 'fra-core-hub-01')
    // fra-prod-core's description mentions "edge" firewalls.
    expect([hub.appliance?.title, hub.appliance?.confidence]).toEqual(['Likely router or firewall', 'medium'])
    expect(hub.appliance!.reasons.join(' ')).toMatch(/4 LANs are more than an ordinary server needs.*fra-prod-core mentions “edge”/)

    const dc = m.nodes.get(hub.dcId!)!
    const withDc = (description: string) => {
      const nodes = new Map(m.nodes).set(dc.id, { ...dc, name: 'dc-a', facts: [{ label: 'Description', value: description }] })
      return detect({ ...m, nodes }, hub)
    }
    expect(withDc('shared services')).toMatchObject({ title: 'Possible router or firewall', confidence: 'low' })
    const cisco = withDc('Firepower firewalls for the core')!
    expect(cisco.confidence).toBe('medium')
    expect(cisco.reasons.at(-1)).toBe('Its datacenter dc-a mentions Cisco Secure Firewall (FTDv).')
  })

  it('leaves ordinary servers alone', () => {
    for (const name of ['bastion-01', 'lhr-proxy-01', 'fra-core-web-01', 'data-etl-01', 'erp-app-01']) {
      expect(named(m, name).appliance, name).toBeUndefined()
    }
  })

  it('is searchable', () => {
    const hits = search(m, 'is:appliance').hits.map((h) => h.node.name)
    expect(hits).toContain('fra-core-vpn-01')
    expect(hits).toHaveLength(10)
    expect(search(m, 'cisco').hits.map((h) => h.node.name)).toEqual(expect.arrayContaining(['lhr-edge-gw-01', 'txl-core-vpn-01']))
  })

  it('knows common products', () => {
    const product = (image: string) => IMAGE_RULES.find((r) => r.pattern.test(image))?.product
    expect(product('FortiGate-VM64-KVM-v7.4.qcow2')).toBe('Fortinet FortiGate-VM')
    expect(product('PA-VM-KVM-11.1.0')).toBe('Palo Alto VM-Series')
    expect(product('csr1000v-universalk9.17.03.08')).toBe('Cisco CSR 1000V')
    expect(product('vyos-1.4-rolling')).toBe('VyOS')
    expect(product('ubuntu-22.04-server-cloudimg')).toBeUndefined()
    expect(product('canvas-renderer')).toBeUndefined()
  })
})

describe('VPN gateways', async () => {
  const m = await fixtureModel()

  it('places gateways in their datacenter and resolves tunnel ends', () => {
    const gw = named(m, 'vpngw-mgmt')
    expect([gw.kind, gw.subtype, m.nodes.get(gw.dcId!)!.name]).toEqual(['vpngateway', 'IPsec', 'fra-mgmt'])
    const lans = m.edgesByNode
      .get(gw.id)!
      .filter((e) => e.kind === 'connection')
      .map((e) => m.nodes.get(e.to)!.name)
    expect(lans).toEqual(['mgmt'])
    const ends = (tunnel: string) =>
      m.edgesByNode
        .get(named(m, tunnel).id)!
        .filter((e) => e.kind === 'tunnel')
        .map((e) => [m.nodes.get(e.to)!.kind, m.nodes.get(e.to)!.name])
    expect(ends('txl-core')).toEqual([['server', 'txl-core-vpn-01']])
    expect(ends('hq-office')).toEqual([['external', '192.0.2.10']])
    expect(ends('build-agent-uk')).toEqual([['external', '192.0.2.77']])
    expect(m.edgesByNode.get(named(m, 'laptop-ops-1').id)).toBeUndefined()
    expect(named(m, 'laptop-ops-1').subtype).toBe('WireGuard peer')
  })

  it('finds tunnels by remote host and networks', () => {
    expect(search(m, '172.16.0.0/16').hits.map((h) => h.node.name)).toEqual(['hq-office'])
    expect(search(m, 'kind:vpn').hits.map((h) => h.node.name)).toEqual(['vpngw-mgmt', 'wg-staging'])
  })
})
