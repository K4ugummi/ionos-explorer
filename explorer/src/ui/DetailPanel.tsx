import { useContext, useMemo, useState } from 'react'
import { CompareContext } from '../diff/context'
import { KINDS, subtypeLabel } from '../model/kinds'
import { breadcrumb, related } from '../model/related'
import type { GraphNode, Model, NodeKind } from '../model/types'
import { KindBadge, NodeList } from './common'
import { ChangeFields } from './Changes'
import { IpAddresses } from './IpAddresses'
import { ManualLinks } from './ManualLinks'

export function DetailPanel({
  model,
  node,
  onSelect,
  action,
}: {
  model: Model
  node: GraphNode
  onSelect: (id?: string) => void
  /** Extra button next to "Copy ID", e.g. "Open diagram". */
  action?: { label: string; run: () => void }
}) {
  const crumbs = breadcrumb(model, node.id).slice(0, -1)
  const groups = useMemo(() => related(model, node.id), [model, node.id])
  const children = useMemo(() => {
    const byKind = new Map<NodeKind, GraphNode[]>()
    for (const id of model.children.get(node.id) ?? []) {
      const c = model.nodes.get(id)!
      byKind.set(c.kind, [...(byKind.get(c.kind) ?? []), c])
    }
    return [...byKind]
      .sort((a, b) => KINDS[a[0]].order - KINDS[b[0]].order)
      .map(([kind, nodes]) => ({
        kind,
        nodes: nodes.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
      }))
  }, [model, node.id])
  const labels = Object.entries(node.labels)
  const [copied, setCopied] = useState(false)
  const diff = useContext(CompareContext)
  const change = diff?.byId.get(node.id)
  const since = diff && new Date(diff.older.manifest.createdAt).toLocaleDateString()

  return (
    <article>
      <nav className="crumbs" aria-label="Location">
        {crumbs.map((c, i) => (
          <span key={c.id}>
            {i > 0 && <span className="sep">› </span>}
            <button onClick={() => onSelect(c.id === model.rootId ? undefined : c.id)}>{c.name}</button>
          </span>
        ))}
      </nav>

      <div className="detail-head">
        <KindBadge kind={node.kind} />
        <h1>{node.name}</h1>
        {node.subtype && <span className="pill">{subtypeLabel(node.kind, node.subtype)}</span>}
        {node.state && <span className="pill">{node.state}</span>}
        {node.placeholder && (
          <span className="pill warn" title="Referenced by other resources, but not visible in this snapshot">
            not visible
          </span>
        )}
      </div>
      <div className="detail-id">
        <span>
          {KINDS[node.kind].label} · <code>{node.id}</code>
        </span>
        <button
          className="btn small"
          onClick={() => {
            void navigator.clipboard?.writeText(node.id).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            })
          }}
        >
          {copied ? 'Copied' : 'Copy ID'}
        </button>
        {action && (
          <button className="btn small primary" onClick={action.run}>
            {action.label}
          </button>
        )}
      </div>

      {labels.length > 0 && (
        <div className="labels">
          {labels.map(([k, v]) => (
            <span className="pill" key={k}>
              {k}={v}
            </span>
          ))}
        </div>
      )}

      {change && change.type !== 'removed' && (
        <section className={`section changed-since ${change.type}`}>
          <h2>
            {change.type === 'added' ? `New since ${since}` : `Changed since ${since}`}
            <span className={`chg-pill ${change.type}`}>{change.type}</span>
          </h2>
          <ChangeFields fields={change.fields} />
          {change.modified && <p className="hint">Modified {change.modified}</p>}
          {change.type === 'added' && <p className="hint">Not in the snapshot from {since}.</p>}
        </section>
      )}

      {node.appliance && (
        <section className={`section appliance ${node.appliance.confidence}`}>
          <h2>
            Network appliance: {node.appliance.title}
            <span className="pill">{CONFIDENCE[node.appliance.confidence]}</span>
          </h2>
          <ul>
            {node.appliance.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </section>
      )}

      {node.facts.length > 0 && (
        <section className="section">
          <h2>Properties</h2>
          <dl className="facts">
            {node.facts.map((f, i) => (
              <div key={i} style={{ display: 'contents' }}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <IpAddresses model={model} node={node} />

      {groups.length > 0 && (
        <section className="section">
          <h2>Connections</h2>
          {groups.map((g) => (
            <div className="rel-group" key={g.title}>
              <h3>{g.title}</h3>
              <NodeList model={model} items={g.items} onSelect={onSelect} contextDc={node.dcId} />
            </div>
          ))}
        </section>
      )}

      <ManualLinks model={model} node={node} onSelect={onSelect} />

      {children.length > 0 && (
        <section className="section">
          <h2>Contains</h2>
          {children.map(({ kind, nodes }) => (
            <div className="rel-group" key={kind}>
              <h3>
                {KINDS[kind].plural} ({nodes.length})
              </h3>
              <NodeList model={model} items={nodes.map((n) => ({ node: n }))} onSelect={onSelect} contextDc={node.dcId ?? node.id} />
            </div>
          ))}
        </section>
      )}

      <RawJSON raw={node.raw} open={node.kind === 'other'} />
    </article>
  )
}

const CONFIDENCE = { high: 'certain', medium: 'likely', low: 'possible' } as const

function RawJSON({ raw, open }: { raw: unknown; open: boolean }) {
  const [shown, setShown] = useState(open)
  // Rendered as text only; snapshot content is never interpreted as HTML.
  const text = useMemo(() => (shown ? JSON.stringify(raw, null, 2) : ''), [raw, shown])
  return (
    <details className="section" open={open} onToggle={(e) => setShown(e.currentTarget.open)}>
      <summary>Raw API JSON</summary>
      {raw === undefined ? <div className="empty">Not available in this snapshot.</div> : <pre className="raw">{text}</pre>}
    </details>
  )
}
