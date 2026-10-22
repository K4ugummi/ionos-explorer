import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { KINDS } from '../model/kinds'
import type { Model, NodeKind } from '../model/types'
import { search } from '../search/search'
import { KindBadge } from './common'
import { nodeContext } from './context'

const MAX_ROWS = 300
const EXAMPLES = ['type:cube', 'kind:lan app', 'ip:10.*', 'label:env=prod', 'state:shutoff', 'kind:pcc', 'kind:nic dhcp:off', 'kind:dns', 'is:expiring']

export function SearchPanel({
  model,
  query,
  setQuery,
  selectedId,
  onSelect,
}: {
  model: Model
  query: string
  setQuery: (q: string) => void
  selectedId?: string
  onSelect: (id: string) => void
}) {
  const deferred = useDeferredValue(query)
  const result = useMemo(() => search(model, deferred), [model, deferred])
  // Keyboard cursor; it resets to the top hit whenever the query changes.
  const [cursor, setCursor] = useState({ q: deferred, i: 0 })
  const active = cursor.q === deferred ? cursor.i : 0
  const setActive = (f: (i: number) => number) => setCursor({ q: deferred, i: f(active) })
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const rows = result.hits.slice(0, MAX_ROWS)

  // "/" focuses the search box from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(t.tagName) && !t.isContentEditable) {
        e.preventDefault()
        input.current?.focus()
        input.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    list.current?.querySelector('.result.kbd')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, rows.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter' && rows[active]) {
      onSelect(rows[active].node.id)
    } else if (e.key === 'Escape') {
      setQuery('')
    }
  }

  function toggleKind(kind: NodeKind) {
    const without = query.replace(/(^|\s)-?(kind|is):\S+/gi, '').trim()
    const isActive = result.terms.some((t) => (t.key === 'kind' || t.key === 'is') && !t.negate && t.value === kind)
    setQuery(isActive ? without : `${without} kind:${kind}`.trim())
  }

  const chips = [...result.kindCounts].sort((a, b) => KINDS[a[0]].order - KINDS[b[0]].order)

  return (
    <aside className="search" aria-label="Search">
      <div className="search-box">
        <input
          ref={input}
          type="search"
          placeholder="Search names, IPs, IDs, labels…  ( / )"
          aria-label="Search the contract"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          autoFocus
          spellCheck={false}
        />
        {query.trim() === '' ? (
          <div className="search-hint">
            Try{' '}
            {EXAMPLES.map((ex, i) => (
              <span key={ex}>
                {i > 0 && ', '}
                <code role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => setQuery(ex)}>
                  {ex}
                </code>
              </span>
            ))}
            . Filters: kind, is, type, dc, loc, ip, mac, label, state, id, dhcp; prefix with - to exclude.
          </div>
        ) : (
          chips.length > 0 && (
            <div className="kind-chips" role="group" aria-label="Filter by kind">
              {chips.map(([kind, n]) => (
                <button
                  key={kind}
                  aria-pressed={result.terms.some((t) => (t.key === 'kind' || t.key === 'is') && !t.negate && t.value === kind)}
                  onClick={() => toggleKind(kind)}
                >
                  {KINDS[kind].plural} {n}
                </button>
              ))}
            </div>
          )
        )}
      </div>

      {query.trim() !== '' && (
        <>
          <div className="results-status" aria-live="polite">
            {result.hits.length === 0
              ? 'No matches'
              : `${result.hits.length} ${result.hits.length === 1 ? 'match' : 'matches'}${result.hits.length > MAX_ROWS ? `, showing ${MAX_ROWS}` : ''}`}
          </div>
          <ul className="results" ref={list} role="listbox" aria-label="Results">
            {rows.map(({ node }, i) => (
              <li
                key={node.id}
                role="option"
                aria-selected={node.id === selectedId}
                className={`result${node.id === selectedId ? ' active' : ''}${i === active ? ' kbd' : ''}`}
                onClick={() => {
                  setActive(() => i)
                  onSelect(node.id)
                }}
              >
                <KindBadge kind={node.kind} />
                <span className="name">{node.name}</span>
                <span className="sub">{nodeContext(model, node) || KINDS[node.kind].label}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  )
}
