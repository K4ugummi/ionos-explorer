import { useContext, useMemo, useState } from 'react'
import { addLink, addSite, removeLink, removeSite, siteNodeId, type Site } from '../annotations/annotations'
import { AnnotationsContext } from '../annotations/context'
import type { GraphNode, Model, NodeKind } from '../model/types'
import { search } from '../search/search'
import { KindBadge } from './common'
import { nodeContext } from './context'

/** Resources a manual link can start or end at. */
export const LINKABLE = new Set<NodeKind>([
  'datacenter',
  'server',
  'lan',
  'vpngateway',
  'external',
  'pcc',
  'nlb',
  'alb',
  'natgateway',
  'k8s',
  'nodepool',
  'postgres',
])

/** Links the user added to this node, and a form to add more. */
export function ManualLinks({ model, node, onSelect }: { model: Model; node: GraphNode; onSelect: (id: string) => void }) {
  const ctx = useContext(AnnotationsContext)
  const [adding, setAdding] = useState(false)
  if (!ctx || !LINKABLE.has(node.kind)) return null
  const links = (model.edgesByNode.get(node.id) ?? []).filter((e) => e.kind === 'manual')
  const site = node.subtype === 'Site' ? (node.raw as Site) : undefined

  return (
    <section className="section manual-links">
      <h2>Manual links</h2>
      {node.appliance && links.length === 0 && (
        <p className="hint">
          Tunnels or routes configured inside this VM are invisible to the IONOS API. Add them here so they show up in the diagram.
        </p>
      )}
      {links.length > 0 && (
        <ul className="rel-list">
          {links.map((e) => {
            const other = model.nodes.get(e.from === node.id ? e.to : e.from)!
            return (
              <li key={e.ref} className="with-action">
                <button onClick={() => onSelect(other.id)}>
                  <KindBadge kind={other.kind} />
                  <span>{other.name}</span>
                  <span className="ctx">
                    {[e.label, other.dcId && other.dcId !== node.dcId ? model.nodes.get(other.dcId)?.name : undefined]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </button>
                <button
                  className="btn small"
                  aria-label={`Remove link to ${other.name}`}
                  title="Remove this link"
                  onClick={() => ctx.update((a) => removeLink(a, e.ref!))}
                >
                  ✕
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {adding ? (
        <AddLink model={model} from={node} onDone={() => setAdding(false)} />
      ) : (
        <div className="row">
          <button className="btn small" onClick={() => setAdding(true)}>
            Add link…
          </button>
          {site && (
            <button
              className="btn small"
              onClick={() => {
                ctx.update((a) => removeSite(a, site.id))
                onSelect(model.rootId)
              }}
            >
              Delete this site
            </button>
          )}
        </div>
      )}
    </section>
  )
}

function AddLink({ model, from, onDone }: { model: Model; from: GraphNode; onDone: () => void }) {
  const ctx = useContext(AnnotationsContext)!
  const [mode, setMode] = useState<'resource' | 'site'>('resource')
  const [target, setTarget] = useState<GraphNode>()
  const [siteName, setSiteName] = useState('')
  const [siteHosts, setSiteHosts] = useState('')
  const [label, setLabel] = useState('')
  const [note, setNote] = useState('')

  const ready = mode === 'resource' ? !!target : !!siteName.trim()

  const submit = () => {
    if (!ready) return
    ctx.update((a) => {
      let to = target?.id
      if (mode === 'site') {
        const hosts = siteHosts.split(/[\s,;]+/).filter(Boolean)
        const [next, site] = addSite(a, { name: siteName.trim(), hosts })
        a = next
        to = siteNodeId(site)
      }
      return addLink(a, { from: from.id, to: to!, label: label.trim() || undefined, note: note.trim() || undefined })
    })
    onDone()
  }

  return (
    <form
      className="add-link"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className="seg" role="radiogroup" aria-label="Link to">
        <button type="button" role="radio" aria-checked={mode === 'resource'} onClick={() => setMode('resource')}>
          A resource or site
        </button>
        <button type="button" role="radio" aria-checked={mode === 'site'} onClick={() => setMode('site')}>
          A new external site
        </button>
      </div>

      {mode === 'resource' ? (
        target ? (
          <div className="picked">
            <KindBadge kind={target.kind} />
            <span>{target.name}</span>
            <span className="ctx">{nodeContext(model, target)}</span>
            <button type="button" className="btn small" onClick={() => setTarget(undefined)} aria-label="Choose another">
              ✕
            </button>
          </div>
        ) : (
          <ResourcePicker
            model={model}
            accept={(n) => LINKABLE.has(n.kind) && n.id !== from.id}
            placeholder="Search a server, gateway, datacenter or site…"
            label="Link target"
            onPick={setTarget}
          />
        )
      ) : (
        <>
          <input
            autoFocus
            placeholder="Name, e.g. Head office"
            aria-label="Site name"
            value={siteName}
            onChange={(e) => setSiteName(e.target.value)}
          />
          <input
            placeholder="Public IPs or hosts (optional; VPN tunnels to them end here)"
            aria-label="Site hosts"
            value={siteHosts}
            onChange={(e) => setSiteHosts(e.target.value)}
          />
        </>
      )}

      <input placeholder="Label, e.g. IPsec, GRE, MPLS" aria-label="Link label" value={label} onChange={(e) => setLabel(e.target.value)} />
      <input placeholder="Note (optional)" aria-label="Link note" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="row">
        <button className="btn small primary" type="submit" disabled={!ready}>
          Add link
        </button>
        <button className="btn small" type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
      <p className="hint">Stored in this browser only. Export the file on the Overview page to keep or share it.</p>
    </form>
  )
}

/**
 * A search box that lists matching resources to pick one (the first eight
 * that `accept` lets through). Enter picks the first; Escape calls `onCancel`.
 */
export function ResourcePicker({
  model,
  accept,
  placeholder,
  label,
  onPick,
  onCancel,
}: {
  model: Model
  accept: (n: GraphNode) => boolean
  placeholder: string
  label: string
  onPick: (n: GraphNode) => void
  onCancel?: () => void
}) {
  const [query, setQuery] = useState('')
  const results = useMemo(
    () =>
      query.trim()
        ? search(model, query, 60)
            .hits.map((h) => h.node)
            .filter(accept)
            .slice(0, 8)
        : [],
    [model, query, accept],
  )
  return (
    <>
      <input
        autoFocus
        type="search"
        placeholder={placeholder}
        aria-label={label}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && results[0]) {
            e.preventDefault()
            onPick(results[0])
          } else if (e.key === 'Escape' && onCancel) {
            e.preventDefault()
            onCancel()
          }
        }}
      />
      {results.length > 0 && (
        <ul className="rel-list">
          {results.map((n) => (
            <li key={n.id}>
              <button type="button" onClick={() => onPick(n)}>
                <KindBadge kind={n.kind} />
                <span>{n.name}</span>
                <span className="ctx">{nodeContext(model, n)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
