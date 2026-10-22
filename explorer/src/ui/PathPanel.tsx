import { useEffect, useMemo, useState } from 'react'
import { describePath, findPaths, nodeLine, pathsText } from '../model/paths'
import type { Model } from '../model/types'
import { KindBadge } from './common'

/**
 * The path view in words, for the details drawer: each route from one
 * resource to the other, step by step, usable without the canvas. One
 * route can be lit up on the canvas (`route`, 1-based; the others dim),
 * and all of them copied as text. With no route, why that may be and what
 * to do about it.
 */
export function PathPanel({
  model,
  from,
  to,
  route,
  onSelect,
  onRoute,
  onReverse,
}: {
  model: Model
  from: string
  to: string
  route?: number
  onSelect: (id: string) => void
  onRoute: (route?: number) => void
  onReverse: () => void
}) {
  const paths = useMemo(() => findPaths(model, from, to), [model, from, to])
  const steps = useMemo(() => paths.map((p) => describePath(model, p)), [model, paths])
  const [a, b] = [model.nodes.get(from)!, model.nodes.get(to)!]
  const name = (id: string) => model.nodes.get(id)!.name
  const [copied, setCopied] = useState<'ok' | 'failed'>()
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(undefined), 2500)
    return () => clearTimeout(t)
  }, [copied])
  const copy = () => {
    const text = pathsText(model, from, to, paths)
    // The clipboard needs a secure context (https or localhost); without one, say so.
    const write = navigator.clipboard?.writeText(text)
    if (!write) return setCopied('failed')
    write.then(
      () => setCopied('ok'),
      () => setCopied('failed'),
    )
  }

  return (
    <article className="path-panel">
      <div className="detail-head">
        <h1>Path</h1>
      </div>
      <p className="path-ends">
        <button className="link" onClick={() => onSelect(a.id)}>
          {a.name}
        </button>
        <span aria-label="to"> → </span>
        <button className="link" onClick={() => onSelect(b.id)}>
          {b.name}
        </button>
      </p>
      <div className="row detail-actions">
        <button className="btn small" onClick={onReverse} title={`From ${b.name} to ${a.name}`}>
          Reverse
        </button>
        <button className="btn small" onClick={copy} title="Copy the routes, step by step, as plain text">
          Copy as text
        </button>
        <span className="path-copied" role="status">
          {copied === 'ok' ? 'Copied' : copied === 'failed' ? 'The browser did not allow copying' : ''}
        </span>
      </div>

      {paths.length === 0 ? (
        <section className="section path-none" aria-live="polite">
          <h2>No route found</h2>
          <p>
            Nothing in this snapshot connects {a.name} and {b.name}: no LANs, Cross Connects, VPN tunnels, manual links or network
            appliances lead from one to the other. The diagram shows what is near each.
          </p>
          <p className="hint">
            The IONOS API does not see tunnels or routes configured inside VMs (IPsec on a firewall VM, for example). If they are connected
            that way, add a manual link in the details of a resource on the way; paths use it.
          </p>
          <div className="row">
            <button className="btn small" onClick={() => onSelect(a.id)}>
              Open {a.name}
            </button>
            <button className="btn small" onClick={() => onSelect(b.id)}>
              Open {b.name}
            </button>
          </div>
        </section>
      ) : (
        <>
          <p className="hint">
            {paths.length === 1 ? 'One route' : `${paths.length} shortest routes`}. Traffic is assumed to pass LANs, Cross Connects, load
            balancers, VPN gateways, sites and servers detected as network appliances; other servers in both LANs only as a last resort.
          </p>
          {paths.map((p, i) => (
            <section className={`section path-route${route === i + 1 ? ' lit' : ''}`} key={p.nodes.join('>')}>
              <h2>
                {paths.length > 1 ? `Route ${i + 1}` : 'Route'}
                <span className="pill">{p.edges.length === 1 ? '1 hop' : `${p.edges.length} hops`}</span>
                {p.plain.length > 0 && (
                  <span className="pill warn" title={`Only if ${p.plain.map(name).join(', ')} forwards traffic`}>
                    through {p.plain.length === 1 ? 'a server' : `${p.plain.length} servers`} not known to route
                  </span>
                )}
                {paths.length > 1 && (
                  <button
                    className="btn small path-show"
                    aria-pressed={route === i + 1}
                    onClick={() => onRoute(route === i + 1 ? undefined : i + 1)}
                    title={route === i + 1 ? 'Show all routes on the canvas again' : 'Light up this route on the canvas; the others dim'}
                  >
                    {route === i + 1 ? 'Shown' : 'Show'}
                  </button>
                )}
              </h2>
              <ol className="path-steps">
                {p.nodes.map((id, j) => {
                  const n = model.nodes.get(id)!
                  return (
                    <li key={id}>
                      <button onClick={() => onSelect(id)}>
                        <KindBadge kind={n.kind} />
                        <span>{n.name}</span>
                        <span className="ctx">{nodeLine(model, n)}</span>
                      </button>
                      {j < p.edges.length && <div className="path-step">{steps[i][j]}</div>}
                    </li>
                  )
                })}
              </ol>
            </section>
          ))}
        </>
      )}
    </article>
  )
}
