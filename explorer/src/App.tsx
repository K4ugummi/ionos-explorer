import { useDeferredValue, useMemo, useState } from 'react'
import './App.css'
import { diagramFor } from './diagram/build'
import { DiagramView } from './diagram/DiagramView'
import type { GraphNode, Model } from './model/types'
import { search } from './search/search'
import { DetailPanel } from './ui/DetailPanel'
import { OpenScreen } from './ui/OpenScreen'
import { Overview } from './ui/Overview'
import { SearchPanel } from './ui/SearchPanel'
import { useHashState } from './ui/useHashState'

/** Width of the detail drawer over the diagram (see .drawer). */
const DRAWER_WIDTH = 440

function App() {
  const [model, setModel] = useState<Model | null>(null)
  if (!model) return <OpenScreen onLoaded={setModel} />
  return (
    <Explorer
      model={model}
      onClose={() => {
        window.history.replaceState(null, '', window.location.pathname + window.location.search)
        setModel(null)
      }}
    />
  )
}

function Explorer({ model, onClose }: { model: Model; onClose: () => void }) {
  const [params, update] = useHashState()
  const view = params.get('view') === 'overview' ? 'overview' : 'diagram'
  const dcParam = params.get('dc') ?? undefined
  const dcId = dcParam && model.nodes.get(dcParam)?.kind === 'datacenter' ? dcParam : undefined
  const query = params.get('q') ?? ''
  const selected = model.nodes.get(params.get('node') ?? '')
  const shown = selected && selected.id !== model.rootId ? selected : undefined

  const deferredQuery = useDeferredValue(query)
  const matches = useMemo(
    () => (view === 'diagram' && deferredQuery.trim() ? new Set(search(model, deferredQuery).hits.map((h) => h.node.id)) : null),
    [model, view, deferredQuery],
  )

  /** Selection on the canvas: the view stays where it is. */
  const select = (id?: string) => update({ node: id }, true)
  /** Selection from search or links: the diagram follows to where the resource is drawn. */
  const navigate = (id?: string) => (view === 'diagram' && id ? update({ node: id, dc: diagramFor(model, id, dcId) }, true) : select(id))
  const openDc = (id?: string) => update({ view: undefined, dc: id, node: undefined }, true)
  const setQuery = (q: string) => update({ q: q || undefined }, false)
  const home = () => update({ node: undefined, dc: undefined }, true)

  const m = model.manifest
  const issues = model.coverageIssues.length + model.warnings.length

  const action = (node: GraphNode) => {
    if (view === 'overview') {
      if (node.kind === 'datacenter') return { label: 'Open diagram', run: () => openDc(node.id) }
      if (node.kind === 'contract') return undefined
      return { label: 'Show in diagram', run: () => update({ view: undefined, node: node.id, dc: diagramFor(model, node.id) }, true) }
    }
    if (node.kind === 'datacenter' && node.id !== dcId) return { label: 'Open diagram', run: () => openDc(node.id) }
    return undefined
  }

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={home}>
          IONOS Explorer
        </button>
        <div className="tabs" role="tablist" aria-label="View">
          <button role="tab" aria-selected={view === 'diagram'} onClick={() => update({ view: undefined }, true)}>
            Diagram
          </button>
          <button role="tab" aria-selected={view === 'overview'} onClick={() => update({ view: 'overview' }, true)}>
            Overview
          </button>
        </div>
        <div className="meta">
          <span>{model.nodes.get(model.rootId)!.name}</span>
          <span title={m.createdAt}>{new Date(m.createdAt).toLocaleString()}</span>
          <span>
            {m.generator.name} {m.generator.version}
          </span>
          {m.synthetic && <span className="pill">demo data</span>}
          {issues > 0 && (
            <button className="pill warn" onClick={() => update({ view: 'overview', node: undefined }, true)} title="Show what is missing">
              partial visibility ({issues})
            </button>
          )}
        </div>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Open another snapshot
        </button>
      </header>
      <div className="workspace">
        <SearchPanel model={model} query={query} setQuery={setQuery} selectedId={selected?.id} onSelect={navigate} />
        {view === 'diagram' ? (
          <main className="stage">
            <DiagramView
              model={model}
              dcId={dcId}
              selectedId={shown?.id}
              matches={matches}
              onSelect={select}
              onOpenDc={openDc}
              rightInset={shown && window.innerWidth > 760 ? DRAWER_WIDTH : 0}
            />
            {shown && (
              <aside className="drawer" aria-label="Details">
                <button className="btn small drawer-close" onClick={() => select(undefined)} aria-label="Close details">
                  ✕
                </button>
                <DetailPanel key={shown.id} model={model} node={shown} onSelect={navigate} action={action(shown)} />
              </aside>
            )}
          </main>
        ) : (
          <main className="main">
            {shown ? (
              <DetailPanel key={shown.id} model={model} node={shown} onSelect={select} action={action(shown)} />
            ) : (
              <Overview model={model} onSelect={select} onSearch={setQuery} />
            )}
          </main>
        )}
      </div>
    </div>
  )
}

export default App
