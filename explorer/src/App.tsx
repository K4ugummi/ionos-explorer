import { useState } from 'react'
import './App.css'
import type { Model } from './model/types'
import { DetailPanel } from './ui/DetailPanel'
import { OpenScreen } from './ui/OpenScreen'
import { Overview } from './ui/Overview'
import { SearchPanel } from './ui/SearchPanel'
import { useHashState } from './ui/useHashState'

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
  const query = params.get('q') ?? ''
  const selected = model.nodes.get(params.get('node') ?? '')
  const select = (id?: string) => update({ node: id }, true)
  const setQuery = (q: string) => update({ q: q || undefined }, false)
  const m = model.manifest
  const issues = model.coverageIssues.length + model.warnings.length

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => select(undefined)}>
          IONOS Explorer
        </button>
        <div className="meta">
          <span>{model.nodes.get(model.rootId)!.name}</span>
          <span title={m.createdAt}>{new Date(m.createdAt).toLocaleString()}</span>
          <span>
            {m.generator.name} {m.generator.version}
          </span>
          {m.synthetic && <span className="pill">demo data</span>}
          {issues > 0 && (
            <button className="pill warn" onClick={() => select(undefined)} title="Show what is missing">
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
        <SearchPanel model={model} query={query} setQuery={setQuery} selectedId={selected?.id} onSelect={select} />
        <main className="main">
          {selected && selected.id !== model.rootId ? (
            <DetailPanel key={selected.id} model={model} node={selected} onSelect={select} />
          ) : (
            <Overview model={model} onSelect={select} onSearch={setQuery} />
          )}
        </main>
      </div>
    </div>
  )
}

export default App
