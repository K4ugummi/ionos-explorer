import type { GraphNode, Model } from '../model/types'
import { normalizeIP, type IpFix } from './annotations'

/**
 * Parses pasted IP corrections, one NIC per line. Fields are separated by
 * commas, semicolons or tabs (spreadsheet rows), or else by spaces:
 *
 *   server, LAN, ip[, ip…][, note]     fra-core-fw-01, app, 10.7.1.23
 *   server, ip                         when the server has a single NIC
 *   datacenter/server, LAN, ip         when the server name is not unique
 *   MAC or NIC id, ip                  02:01:7e:aa:bb:cc  10.7.1.23
 *
 * The NIC is found by MAC, NIC id, or server plus LAN (or NIC) name. Lines
 * starting with # are ignored.
 */
export interface ParsedLine {
  line: number
  text: string
  fix?: IpFix
  nic?: GraphNode
  error?: string
}

const MAC = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseIpList(model: Model, input: string): ParsedLine[] {
  const nodes = [...model.nodes.values()]
  const nics = nodes.filter((n) => n.kind === 'nic')
  const servers = nodes.filter((n) => n.kind === 'server')
  const lanOf = (nic: GraphNode) => {
    const e = (model.edgesByNode.get(nic.id) ?? []).find((x) => x.kind === 'attached' && x.from === nic.id)
    return e ? model.nodes.get(e.to) : undefined
  }
  const out: ParsedLine[] = []

  input.split(/\r?\n/).forEach((raw, i) => {
    const text = raw.trim()
    if (!text || text.startsWith('#')) return
    const line = i + 1
    const fields = (/[,;\t]/.test(text) ? text.split(/[,;\t]/) : text.split(/\s+/)).map((f) => f.trim()).filter(Boolean)
    const ips: string[] = []
    const words: string[] = []
    for (const f of fields) {
      const ip = MAC.test(f) ? undefined : normalizeIP(f)
      if (ip) ips.push(ip)
      else if (ips.length)
        words.push(`\u0000${f}`) // after the IPs: part of the note
      else words.push(f)
    }
    const note =
      words
        .filter((w) => w.startsWith('\u0000'))
        .map((w) => w.slice(1))
        .join(', ') || undefined
    const keys = words.filter((w) => !w.startsWith('\u0000'))
    const fail = (error: string) => out.push({ line, text, error })
    if (!ips.length) return fail('No IP address on this line.')
    if (!keys.length) return fail('Say which NIC: a MAC, a NIC id, or a server name (and LAN).')

    let nic: GraphNode | undefined
    const [first, second] = keys
    if (MAC.test(first)) {
      const mac = first.toLowerCase().replaceAll('-', ':')
      nic = nics.find((n) => n.macs.some((m) => m.toLowerCase() === mac))
      if (!nic) return fail(`No NIC with MAC ${first} in this snapshot.`)
    } else if (UUID.test(first) && model.nodes.get(first.toLowerCase())?.kind === 'nic') {
      nic = model.nodes.get(first.toLowerCase())
    } else {
      const [dcName, serverName] = first.includes('/') ? first.split('/', 2) : [undefined, first]
      const found = servers.filter(
        (s) =>
          (s.id === first.toLowerCase() || s.name.toLowerCase() === serverName.toLowerCase()) &&
          (!dcName || model.nodes.get(s.dcId ?? '')?.name.toLowerCase() === dcName.toLowerCase()),
      )
      if (!found.length) return fail(`No server or NIC “${first}” in this snapshot.`)
      if (found.length > 1) {
        const where = found.map((s) => model.nodes.get(s.dcId ?? '')?.name ?? '?').join(', ')
        return fail(`${found.length} servers are called “${serverName}” (in ${where}). Write datacenter/server, or use the MAC.`)
      }
      const own = (model.children.get(found[0].id) ?? []).map((id) => model.nodes.get(id)!).filter((n) => n.kind === 'nic')
      if (second) {
        const want = second.toLowerCase()
        const matches = own.filter((n) => lanOf(n)?.name.toLowerCase() === want || n.name.toLowerCase() === want || n.id === want)
        if (matches.length !== 1) {
          const lans = own.map((n) => lanOf(n)?.name ?? n.name).join(', ')
          return fail(`${found[0].name} has ${matches.length ? 'several NICs' : 'no NIC'} in “${second}”. Its LANs: ${lans || 'none'}.`)
        }
        nic = matches[0]
      } else if (own.length === 1) {
        nic = own[0]
      } else {
        const lans = own.map((n) => lanOf(n)?.name ?? n.name).join(', ')
        return fail(`${found[0].name} has ${own.length} NICs. Add the LAN (${lans}).`)
      }
    }
    out.push({ line, text, nic, fix: { nic: nic!.id, ips: [...new Set(ips)].slice(0, 16), note } })
  })
  return out
}
