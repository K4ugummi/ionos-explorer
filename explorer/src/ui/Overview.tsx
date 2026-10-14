import { useMemo } from 'react'
import { KINDS, SERVER_TYPES } from '../model/kinds'
import type { GraphNode, Model, NodeKind } from '../model/types'
import { KindBadge } from './common'

export function Overview({
  model,
  onSelect,
  onSearch,
}: {
  model: Model
  onSelect: (id: string) => void
  onSearch: (q: string) => void
}) {
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
          <strong>Partial visibility.</strong> Some data could not be exported. Resources behind these endpoints are
          missing from search and diagrams.
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
                    <span className="ctx">{dcs.length ? dcs.join(' ↔ ') : 'no peers'}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </div>
  )
}

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
    dcCounts.set(dc.id, [
      `${servers.length} servers`,
      ...[...byType].sort().map(([t, n]) => `${n} ${SERVER_TYPES[t] ?? t}`),
      `${kids.filter((k) => k.kind === 'lan').length} LANs`,
      ...(ccs.size ? [`${ccs.size} Cross Connect${ccs.size > 1 ? 's' : ''}`] : []),
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
      .map(([t, label]) => ({ label: `${label} servers`, count: servers.filter((s) => s.subtype === t).length, query: `type:${t.toLowerCase()}` }))
      .filter((s) => s.count > 0),
    ...(['lan', 'pcc', 'nlb', 'alb', 'natgateway', 'k8s', 'postgres', 'volume', 'ipblock', 'other'] as NodeKind[])
      .map((k) => ({ label: KINDS[k].plural, count: of(k).length, query: `kind:${k}` }))
      .filter((s) => s.count > 0),
  ]

  return { dcs, locations: [...locations].sort((a, b) => a[0].localeCompare(b[0])), dcCounts, pccs, stats }
}
