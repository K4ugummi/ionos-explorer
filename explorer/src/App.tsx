import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import './App.css'
import { applyAnnotations, isEmpty, loadStored, saveStored, storageKey, type Annotations } from './annotations/annotations'
import { AnnotationsContext } from './annotations/context'
import { diagramFor } from './diagram/build'
import { CompareContext } from './diff/context'
import { compareModels, markChanges } from './diff/diff'
import { DEFAULT_HOPS } from './model/paths'
import type { GraphNode, Model } from './model/types'
import { search } from './search/search'
import { Changes } from './ui/Changes'
import { DetailPanel } from './ui/DetailPanel'
import { modeParams, parseMode, type DiagramMode } from './ui/mode'
import { OpenScreen } from './ui/OpenScreen'
import { Overview } from './ui/Overview'
import { PathPanel } from './ui/PathPanel'
import { SearchPanel } from './ui/SearchPanel'
import { useHashState } from './ui/useHashState'

// React Flow, ELK and the canvas are only needed on the Diagram tab: their own
// chunk, fetched once the user starts opening a snapshot (see App).
type DiagramViewType = typeof import('./diagram/DiagramView').DiagramView
let diagramChunk: Promise<DiagramViewType> | undefined
let loadedDiagram: DiagramViewType | undefined
const loadDiagram = () =>
  (diagramChunk ??= import('./diagram/DiagramView').then(
    (m) => (loadedDiagram = m.DiagramView),
    (err: unknown) => {
      diagramChunk = undefined // try again next time
      throw err
    },
  ))

/**
 * The diagram component, once its chunk is there. Not React.lazy: a lazy
 * component suspends even when its chunk is already loaded, and React keeps
 * a Suspense fallback it has shown for at least 300 ms.
 */
function useDiagramView() {
  const [state, setState] = useState<{ view?: DiagramViewType; error?: string }>(() => ({ view: loadedDiagram }))
  useEffect(() => {
    if (state.view) return
    let live = true
    loadDiagram().then(
      (view) => live && setState({ view }),
      (err: unknown) => live && setState({ error: err instanceof Error ? err.message : String(err) }),
    )
    return () => {
      live = false
    }
  }, [state.view])
  return state
}

/** Width of the detail drawer over the diagram (see .drawer). */
const DRAWER_WIDTH = 440

function App() {
  // `older`: a snapshot of the same contract to compare with. The open one is always the newer.
  const [open, setOpen] = useState<{ model: Model; demoLinks?: Annotations; older?: Model } | null>(null)
  // Fetch the diagram code once the user starts opening a snapshot, while it is read.
  useEffect(() => {
    if (open) return
    const preload = () => void loadDiagram().catch(() => {}) // reported when the diagram is shown
    const events = ['pointerdown', 'keydown', 'dragenter'] as const
    for (const e of events) window.addEventListener(e, preload, { once: true, capture: true })
    return () => events.forEach((e) => window.removeEventListener(e, preload, { capture: true }))
  }, [open])
  if (!open) return <OpenScreen onLoaded={(model, demoLinks) => setOpen({ model, demoLinks })} />
  const compare = (other?: Model) =>
    setOpen((o) => {
      if (!o) return o
      if (!other) return { ...o, older: undefined }
      const newer = new Date(other.manifest.createdAt) > new Date(o.model.manifest.createdAt)
      return newer ? { ...o, model: other, older: o.model } : { ...o, older: other }
    })
  return (
    <Explorer
      model={open.model}
      older={open.older}
      onCompare={compare}
      demoLinks={open.demoLinks}
      onClose={() => {
        window.history.replaceState(null, '', window.location.pathname + window.location.search)
        setOpen(null)
      }}
    />
  )
}

function Explorer({
  model: snapshotModel,
  older,
  onCompare,
  demoLinks,
  onClose,
}: {
  model: Model
  older?: Model
  onCompare: (other?: Model) => void
  demoLinks?: Annotations
  onClose: () => void
}) {
  // Manual links, sites, IP corrections and moved boxes, kept in this browser per contract.
  const key = storageKey(snapshotModel)
  const contract = snapshotModel.manifest.contract?.number
  const [annotations, setAnnotations] = useState(() => {
    const stored = loadStored(key)
    return demoLinks && isEmpty(stored) ? demoLinks : stored
  })
  useEffect(() => saveStored(key, annotations, contract), [key, annotations, contract])
  const updateAnnotations = useCallback((fn: (a: Annotations) => Annotations) => setAnnotations(fn), [])
  // Box positions are left out: moving a box keeps the model (and every layout, search and path cached on it).
  const { sites, links, ips } = annotations
  const applied = useMemo(() => applyAnnotations(snapshotModel, { sites, links, ips }), [snapshotModel, sites, links, ips])
  // Compared without annotations, so links and IP corrections are not "changes".
  const diff = useMemo(() => (older ? compareModels(older, snapshotModel) : undefined), [older, snapshotModel])
  const model = useMemo(() => markChanges(applied.model, diff), [applied.model, diff])
  const annotationsState = useMemo(
    () => ({ annotations, update: updateAnnotations, dangling: applied.dangling, staleIps: applied.staleIps, contract }),
    [annotations, updateAnnotations, applied.dangling, applied.staleIps, contract],
  )

  const { view: DiagramView, error: diagramError } = useDiagramView()

  const [params, update] = useHashState()
  const viewParam = params.get('view')
  const view = viewParam === 'overview' || viewParam === 'changes' ? viewParam : 'diagram'
  const dcParam = params.get('dc') ?? undefined
  const dcId = dcParam && model.nodes.get(dcParam)?.kind === 'datacenter' ? dcParam : undefined
  const query = params.get('q') ?? ''
  const selected = model.nodes.get(params.get('node') ?? '')
  const shown = selected && selected.id !== model.rootId ? selected : undefined
  // Focus or path view on top of the contract or datacenter view (whose `dc` stays, to go back to).
  const [focus, path, hops] = [params.get('focus'), params.get('path'), params.get('hops')]
  const mode = useMemo(() => (view === 'diagram' ? parseMode({ focus, path, hops }, model) : undefined), [view, focus, path, hops, model])
  const pathMode = mode?.kind === 'path' ? mode : undefined

  const deferredQuery = useDeferredValue(query)
  const matches = useMemo(
    () => (view === 'diagram' && deferredQuery.trim() ? new Set(search(model, deferredQuery).hits.map((h) => h.node.id)) : null),
    [model, view, deferredQuery],
  )

  /** Selection on the canvas: the view stays where it is. */
  const select = (id?: string) => update({ node: id }, true)
  /**
   * Selection from search or links: the diagram follows to where the resource
   * is drawn. A focus or path view stays (the canvas offers to leave it if
   * the resource is not in it).
   */
  const navigate = (id?: string) =>
    view === 'diagram' && id && !mode ? update({ node: id, dc: diagramFor(model, id, dcId) }, true) : select(id)
  const openDc = (id?: string) => update({ view: undefined, dc: id, node: undefined, ...modeParams() }, true)
  const setQuery = (q: string) => update({ q: q || undefined }, false)
  const home = () => update({ node: undefined, dc: undefined, ...modeParams() }, true)
  /** Into a focus or path view; the diagram tab and the selection go along. */
  const enter = (next: DiagramMode, node?: string) => update({ view: undefined, node, ...modeParams(next) }, true)
  /** Back from a focus or path view to the view below it, or to another datacenter's (null: the contract view). */
  const leave = (dc?: string | null) => update({ ...modeParams(), ...(dc !== undefined ? { dc: dc ?? undefined } : {}) }, true)
  const setHops = (hops: number) => mode && update(modeParams({ ...mode, hops }), false)

  const m = model.manifest
  const issues = model.coverageIssues.length + model.warnings.length

  const action = (node: GraphNode) => {
    if (view !== 'diagram') {
      if (node.kind === 'datacenter') return { label: 'Open diagram', run: () => openDc(node.id) }
      if (node.kind === 'contract') return undefined
      return {
        label: 'Show in diagram',
        run: () => update({ view: undefined, node: node.id, dc: diagramFor(model, node.id), ...modeParams() }, true),
      }
    }
    if (node.kind === 'datacenter' && node.id !== dcId) return { label: 'Open diagram', run: () => openDc(node.id) }
    return undefined
  }

  return (
    <AnnotationsContext.Provider value={annotationsState}>
      <CompareContext.Provider value={diff}>
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
              <button role="tab" aria-selected={view === 'changes'} onClick={() => update({ view: 'changes', node: undefined }, true)}>
                Changes
                {diff && <span className="tab-count">{diff.changes.length}</span>}
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
                <button
                  className="pill warn"
                  onClick={() => update({ view: 'overview', node: undefined }, true)}
                  title="Show what is missing"
                >
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
                {DiagramView ? (
                  <DiagramView
                    model={model}
                    dcId={dcId}
                    selectedId={shown?.id}
                    matches={matches}
                    onSelect={select}
                    onOpenDc={openDc}
                    mode={mode}
                    onHops={setHops}
                    onLeave={leave}
                    rightInset={(shown || pathMode) && window.innerWidth > 760 ? DRAWER_WIDTH : 0}
                  />
                ) : (
                  <div className="dg-status" role="status">
                    {diagramError ? `Could not load the diagram: ${diagramError}` : 'Loading the diagram…'}
                  </div>
                )}
                {shown ? (
                  <aside className="drawer" aria-label="Details">
                    <button className="btn small drawer-close" onClick={() => select(undefined)} aria-label="Close details">
                      ✕
                    </button>
                    {pathMode && (
                      <button className="btn small drawer-back" onClick={() => select(undefined)}>
                        ‹ Path steps
                      </button>
                    )}
                    <DetailPanel
                      key={shown.id}
                      model={model}
                      node={shown}
                      onSelect={navigate}
                      action={action(shown)}
                      onFocus={() => enter({ kind: 'focus', id: shown.id, hops: DEFAULT_HOPS }, shown.id)}
                      onPath={(to) => enter({ kind: 'path', from: shown.id, to, hops: DEFAULT_HOPS })}
                    />
                  </aside>
                ) : (
                  pathMode && (
                    <aside className="drawer" aria-label="Path">
                      <button className="btn small drawer-close" onClick={() => leave()} aria-label="Close the path view">
                        ✕
                      </button>
                      <PathPanel
                        model={model}
                        from={pathMode.from}
                        to={pathMode.to}
                        onSelect={select}
                        onReverse={() => enter({ ...pathMode, from: pathMode.to, to: pathMode.from })}
                      />
                    </aside>
                  )
                )}
              </main>
            ) : (
              <main className="main">
                {shown ? (
                  <DetailPanel
                    key={shown.id}
                    model={model}
                    node={shown}
                    onSelect={select}
                    action={action(shown)}
                    onFocus={() => enter({ kind: 'focus', id: shown.id, hops: DEFAULT_HOPS }, shown.id)}
                    onPath={(to) => enter({ kind: 'path', from: shown.id, to, hops: DEFAULT_HOPS })}
                  />
                ) : view === 'changes' ? (
                  <Changes model={snapshotModel} diff={diff} onCompare={onCompare} onSelect={select} />
                ) : (
                  <Overview model={model} onSelect={select} onSearch={setQuery} />
                )}
              </main>
            )}
          </div>
        </div>
      </CompareContext.Provider>
    </AnnotationsContext.Provider>
  )
}

export default App
