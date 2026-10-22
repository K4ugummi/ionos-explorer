import { useContext, useMemo, useRef, useState } from 'react'
import { isEmpty, merge, parse, removeIpFix, removeLink, resetPositions, serialize, setIpFix } from '../annotations/annotations'
import { parseIpList, type ParsedLine } from '../annotations/ipList'
import { AnnotationsContext } from '../annotations/context'
import { KINDS, SERVER_TYPES } from '../model/kinds'
import type { GraphNode, Model, NodeKind } from '../model/types'
import { KindBadge } from './common'
import { nodeContext } from './context'

export function Overview({ model, onSelect, onSearch }: { model: Model; onSelect: (id: string) => void; onSearch: (q: string) => void }) {
  const data = useMemo(() => summarize(model), [model])
  const root = model.nodes.get(model.rootId)!

  return (
    <div className="overview">
      <h1>{root.name}</h1>
      <p className="lead">
        {data.dcs.length} datacenters in {data.locations.length} locations · snapshot from{' '}
        {new Date(model.manifest.createdAt).toLocaleString()}
      </p>

      {(model.coverageIssues.length > 0 || model.warnings.length > 0) && (
        <div className="notice" role="note">
          <strong>Partial visibility.</strong> Some data could not be exported. Resources behind these endpoints are missing from search and
          diagrams.
          <ul>
            {model.coverageIssues.map((c) => (
              <li key={`${c.api}${c.endpoint}${c.status}`}>
                <code>{c.endpoint}</code> ({c.api}): {c.status.replace('_', ' ')}
                {c.count > 1 ? ` in ${c.count} requests` : ''}
                {c.error ? ` (${c.error})` : ''}
              </li>
            ))}
            {model.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="stats">
        {data.stats.map((s) => (
          <button className="stat" key={s.label} onClick={() => onSearch(s.query)}>
            <div className="n">{s.count}</div>
            <div className="l">{s.label}</div>
          </button>
        ))}
      </div>

      {data.locations.map(([location, dcs]) => (
        <section className="location" key={location}>
          <h2>{location}</h2>
          <div className="dc-grid">
            {dcs.map((dc) => (
              <button className="dc-card" key={dc.id} onClick={() => onSelect(dc.id)}>
                <span className="title">{dc.name}</span>
                {dc.facts.find((f) => f.label === 'Description') && (
                  <span className="desc">{dc.facts.find((f) => f.label === 'Description')!.value}</span>
                )}
                <span className="counts">
                  {data.dcCounts.get(dc.id)!.map((c) => (
                    <span className="pill" key={c}>
                      {c}
                    </span>
                  ))}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}

      {data.pccs.length > 0 && (
        <section className="location">
          <h2>Cross Connects</h2>
          <div className="section">
            <ul className="rel-list" style={{ padding: 8 }}>
              {data.pccs.map(({ pcc, dcs }) => (
                <li key={pcc.id}>
                  <button onClick={() => onSelect(pcc.id)}>
                    <KindBadge kind="pcc" />
                    <span>{pcc.name}</span>
                    <span className="ctx">
                      {pcc.subtype === 'unused'
                        ? 'unused, no LAN connected'
                        : `${dcs.join(' ↔ ') || 'peers not in this snapshot'}${pcc.subtype === 'one LAN' ? ' (only 1 LAN)' : ''}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {data.appliances.length > 0 && (
        <section className="location">
          <h2>Network appliances</h2>
          <p className="hint">
            Servers that look like routers, firewalls or VPN endpoints. Links built inside them are invisible to the IONOS API; add them as
            manual links in their details.
          </p>
          <div className="section">
            <ul className="rel-list" style={{ padding: 8 }}>
              {data.appliances.map((n) => (
                <li key={n.id}>
                  <button onClick={() => onSelect(n.id)} title={n.appliance!.reasons.join('\n')}>
                    <KindBadge kind="server" />
                    <span>{n.name}</span>
                    <span className="ctx">
                      {[n.appliance!.title, CONFIDENCE[n.appliance!.confidence], nodeContext(model, n)].join(' · ')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <AnnotationsSection model={model} onSelect={onSelect} />
    </div>
  )
}

const movedBoxes = (boxes: number, views: number) =>
  `${boxes === 1 ? '1 box' : `${boxes} boxes`} moved in ${views === 1 ? '1 diagram' : `${views} diagrams`}.`

const CONFIDENCE = { high: 'certain', medium: 'likely', low: 'possible' } as const

/** Manual links, sites and IP corrections: listing, export and import. */
function AnnotationsSection({ model, onSelect }: { model: Model; onSelect: (id: string) => void }) {
  const ctx = useContext(AnnotationsContext)
  const file = useRef<HTMLInputElement>(null)
  const [message, setMessage] = useState<string>()
  if (!ctx) return null
  const { annotations, dangling, staleIps, contract } = ctx
  const links = model.edges.filter((e) => e.kind === 'manual')
  const name = (id: string) => model.nodes.get(id)?.name ?? id
  const fixes = annotations.ips.flatMap((f) => {
    const nic = model.nodes.get(f.nic)
    return nic?.kind === 'nic' ? [{ fix: f, nic }] : []
  })

  const exportFile = () => {
    const url = URL.createObjectURL(new Blob([serialize(annotations, contract)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `ionos-explorer-annotations${contract ? `-${contract}` : ''}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const importFile = async (f?: File) => {
    if (!f) return
    try {
      const { annotations: incoming, contract: theirs } = parse(await f.text())
      ctx.update((a) => merge(a, incoming))
      setMessage(
        `Imported ${incoming.links.length} links, ${incoming.sites.length} sites, ${incoming.ips.length} IP corrections and ${incoming.positions.length} box positions.` +
          (theirs && contract && theirs !== contract ? ` The file was made for contract ${theirs}, this is ${contract}.` : ''),
      )
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section className="location">
      <h2>Your annotations</h2>
      <p className="hint">
        What you know and the API does not: links inside appliances, other sites, other clouds, and IPs changed inside VMs; and where you
        placed boxes in the diagram. Kept in this browser, separate from the snapshot. Add them from a resource’s details, or paste IP
        corrections below.
      </p>
      <div className="section">
        <h3 className="sub">Manual links</h3>
        {links.length > 0 ? (
          <ul className="rel-list" style={{ padding: 8 }}>
            {links.map((e) => (
              <li key={e.ref} className="with-action">
                <button onClick={() => onSelect(e.from)}>
                  <KindBadge kind={model.nodes.get(e.from)!.kind} />
                  <span>
                    {name(e.from)} ↔ {name(e.to)}
                  </span>
                  <span className="ctx">{e.label}</span>
                </button>
                <button
                  className="btn small"
                  aria-label="Remove link"
                  title="Remove this link"
                  onClick={() => ctx.update((a) => removeLink(a, e.ref!))}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty">No manual links yet.</div>
        )}
        {dangling.length > 0 && (
          <div className="notice" role="note">
            {dangling.length === 1 ? '1 link points' : `${dangling.length} links point`} at resources that are not in this snapshot
            (deleted, or not visible to the exporting user). They are kept.
          </div>
        )}
        <h3 className="sub">IP corrections</h3>
        {fixes.length > 0 ? (
          <ul className="rel-list" style={{ padding: 8 }}>
            {fixes.map(({ fix, nic }) => (
              <li key={fix.nic} className="with-action">
                <button onClick={() => onSelect(nic.parentId ?? nic.id)}>
                  <KindBadge kind="nic" />
                  <span>
                    {name(nic.parentId ?? '')} · {lanName(model, nic)}
                  </span>
                  <span className="ctx">
                    {(nic.ionosIps ?? []).join(', ') || 'no IP'} → {fix.ips.join(', ')}
                  </span>
                </button>
                <button
                  className="btn small"
                  aria-label={`Remove the IP correction for ${name(nic.parentId ?? '')}`}
                  title="Remove this correction"
                  onClick={() => ctx.update((a) => removeIpFix(a, fix.nic))}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty">No IP corrections yet.</div>
        )}
        {staleIps.length > 0 && (
          <div className="notice" role="note">
            {staleIps.length === 1 ? '1 IP correction is' : `${staleIps.length} IP corrections are`} for NICs that are not in this snapshot
            (deleted, or not visible to the exporting user). They are kept.
          </div>
        )}
        <PasteIps model={model} />
        <h3 className="sub">Box positions</h3>
        {annotations.positions.length > 0 ? (
          <div className="row" style={{ padding: 8 }}>
            <span className="hint">
              {movedBoxes(annotations.positions.length, new Set(annotations.positions.map((p) => p.view)).size)} Each view has a “Reset
              layout” button.
            </span>
            <button className="btn small" onClick={() => ctx.update((a) => resetPositions(a))}>
              Reset all
            </button>
          </div>
        ) : (
          <div className="empty">No boxes moved yet. Drag a box in the diagram to place it yourself.</div>
        )}
        <div className="row" style={{ padding: 8, borderTop: '1px solid var(--border)' }}>
          <button className="btn small" onClick={exportFile} disabled={isEmpty(annotations)}>
            Export annotations file
          </button>
          <button className="btn small" onClick={() => file.current?.click()}>
            Import annotations file…
          </button>
          <input
            ref={file}
            type="file"
            accept=".json,application/json"
            hidden
            aria-label="Import annotations file"
            onChange={(e) => {
              void importFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />
          {message && (
            <span className="hint" role="status">
              {message}
            </span>
          )}
        </div>
      </div>
    </section>
  )
}

function lanName(model: Model, nic: GraphNode) {
  const e = (model.edgesByNode.get(nic.id) ?? []).find((x) => x.kind === 'attached' && x.from === nic.id)
  return (e && model.nodes.get(e.to)?.name) ?? nic.name
}

/** Many IP corrections at once, e.g. rows copied from a spreadsheet. */
function PasteIps({ model }: { model: Model }) {
  const ctx = useContext(AnnotationsContext)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [done, setDone] = useState<string>()
  const parsed: ParsedLine[] = useMemo(() => (text.trim() ? parseIpList(model, text) : []), [model, text])
  if (!ctx) return null
  const good = parsed.filter((p) => p.fix)
  if (!open) {
    return (
      <div className="row" style={{ padding: 8 }}>
        <button className="btn small" onClick={() => setOpen(true)}>
          Paste IP corrections…
        </button>
        {done && (
          <span className="hint" role="status">
            {done}
          </span>
        )}
      </div>
    )
  }
  return (
    <div className="add-link ip-paste" style={{ padding: 8 }}>
      <p className="hint">
        One NIC per line: <code>server, LAN, IP</code> (or <code>server, IP</code> for servers with one NIC, <code>datacenter/server</code>{' '}
        for names used twice, <code>MAC, IP</code>, <code>NIC id, IP</code>). Text after the IP becomes the note. Commas, semicolons or tabs
        separate fields, so spreadsheet rows paste as they are.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="IP corrections, one per line"
        spellCheck={false}
        placeholder={'web-01, app, 10.7.1.23\n02:01:7e:aa:bb:cc, 10.7.2.5, changed during migration'}
      />
      {parsed.length > 0 && (
        <ul className="ip-preview" aria-label="Preview">
          {parsed.map((p) =>
            p.fix ? (
              <li key={p.line}>
                ✓ {model.nodes.get(p.nic!.parentId ?? '')?.name} · {lanName(model, p.nic!)}:{' '}
                {(p.nic!.ionosIps ?? p.nic!.ips).join(', ') || 'no IP'} → {p.fix.ips.join(', ')}
              </li>
            ) : (
              <li key={p.line} className="bad">
                ✗ Line {p.line}: {p.error}
              </li>
            ),
          )}
        </ul>
      )}
      <div className="row">
        <button
          className="btn small primary"
          disabled={!good.length}
          onClick={() => {
            ctx.update((a) => good.reduce((acc, p) => setIpFix(acc, p.fix!), a))
            const bad = parsed.length - good.length
            setDone(
              `Saved ${good.length} IP correction${good.length === 1 ? '' : 's'}${bad ? `; ${bad} line${bad === 1 ? '' : 's'} skipped` : ''}.`,
            )
            setText('')
            setOpen(false)
          }}
        >
          Save {good.length || ''} correction{good.length === 1 ? '' : 's'}
        </button>
        <button className="btn small" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  )
}

const RANK = { high: 0, medium: 1, low: 2 }

function summarize(model: Model) {
  const nodes = [...model.nodes.values()]
  const of = (k: NodeKind) => nodes.filter((n) => n.kind === k)
  const dcs = of('datacenter').sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

  const locations = new Map<string, GraphNode[]>()
  for (const dc of dcs) {
    const loc = dc.location ?? 'unknown location'
    locations.set(loc, [...(locations.get(loc) ?? []), dc])
  }

  const dcCounts = new Map<string, string[]>()
  for (const dc of dcs) {
    const kids = (model.children.get(dc.id) ?? []).map((id) => model.nodes.get(id)!)
    const servers = kids.filter((k) => k.kind === 'server')
    const byType = new Map<string, number>()
    servers.forEach((s) => byType.set(s.subtype ?? '?', (byType.get(s.subtype ?? '?') ?? 0) + 1))
    const ccs = new Set(
      kids
        .filter((k) => k.kind === 'lan')
        .flatMap((l) => (model.edgesByNode.get(l.id) ?? []).filter((e) => e.kind === 'cross-connect').map((e) => e.to)),
    )
    const vpns = kids.filter((k) => k.kind === 'vpngateway').length
    dcCounts.set(dc.id, [
      `${servers.length} servers`,
      ...[...byType].sort().map(([t, n]) => `${n} ${SERVER_TYPES[t] ?? t}`),
      `${kids.filter((k) => k.kind === 'lan').length} LANs`,
      ...(ccs.size ? [`${ccs.size} Cross Connect${ccs.size > 1 ? 's' : ''}`] : []),
      ...(vpns ? [`${vpns} VPN gateway${vpns > 1 ? 's' : ''}`] : []),
    ])
  }

  const pccs = of('pcc')
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((pcc) => ({
      pcc,
      dcs: (model.edgesByNode.get(pcc.id) ?? [])
        .filter((e) => e.kind === 'cross-connect')
        .map((e) => model.nodes.get(model.nodes.get(e.from)?.dcId ?? '')?.name ?? '?')
        .sort(),
    }))

  const servers = of('server')
  const stats: { label: string; count: number; query: string }[] = [
    { label: KINDS.datacenter.plural, count: dcs.length, query: 'kind:datacenter' },
    { label: KINDS.server.plural, count: servers.length, query: 'kind:server' },
    ...Object.entries(SERVER_TYPES)
      .map(([t, label]) => ({
        label: `${label} servers`,
        count: servers.filter((s) => s.subtype === t).length,
        query: `type:${t.toLowerCase()}`,
      }))
      .filter((s) => s.count > 0),
    ...(
      [
        'lan',
        'pcc',
        'nlb',
        'alb',
        'natgateway',
        'securitygroup',
        'vpngateway',
        'k8s',
        'postgres',
        'mariadb',
        'mongodb',
        'inmemorydb',
        'kafka',
        'nfs',
        'autoscaling',
        'volume',
        'snapshot',
        'backupunit',
        'ipblock',
        'dnszone',
        'dnsrecord',
        'cdn',
        'certificate',
        'registry',
        'pipeline',
        'external',
        'other',
      ] as NodeKind[]
    )
      .map((k) => ({ label: KINDS[k].plural, count: of(k).length, query: `kind:${k}` }))
      .filter((s) => s.count > 0),
  ]
  const appliances = servers
    .filter((s) => s.appliance)
    .sort(
      (a, b) => RANK[a.appliance!.confidence] - RANK[b.appliance!.confidence] || a.name.localeCompare(b.name, undefined, { numeric: true }),
    )
  if (appliances.length) stats.splice(2, 0, { label: 'Network appliances', count: appliances.length, query: 'is:appliance' })
  const nics = of('nic')
  const unverified = nics.filter((n) => n.dhcp === false && !n.ionosIps).length
  const corrected = nics.filter((n) => n.ionosIps).length
  if (unverified) stats.push({ label: 'NIC IPs not verified (DHCP off)', count: unverified, query: 'kind:nic dhcp:off -is:corrected' })
  if (corrected) stats.push({ label: 'Corrected NIC IPs', count: corrected, query: 'kind:nic is:corrected' })
  const flagged = (flag: string) => [...model.nodes.values()].filter((n) => n.flags?.includes(flag)).length
  const expiring = flagged('expiring')
  const dangling = flagged('dangling')
  if (expiring) stats.push({ label: 'Certificates expired or ending within 30 days', count: expiring, query: 'is:expiring' })
  if (dangling) stats.push({ label: 'DNS records pointing at nothing in the contract', count: dangling, query: 'is:dangling' })

  return { dcs, locations: [...locations].sort((a, b) => a[0].localeCompare(b[0])), dcCounts, pccs, stats, appliances }
}
