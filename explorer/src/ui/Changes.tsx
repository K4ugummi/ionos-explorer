import { useMemo, useRef, useState } from 'react'
import previousDemoUrl from '../../../fixtures/demo-contract-previous.ionx?url'
import { timeBetween, type Change, type ChangeType, type Diff, type FieldChange } from '../diff/diff'
import { KINDS } from '../model/kinds'
import { buildModel } from '../model/build'
import type { Model, NodeKind } from '../model/types'
import { EncryptedSnapshotError, isEncrypted, loadSnapshot } from '../snapshot/load'
import { KindBadge } from './common'

const TYPES: [ChangeType, string][] = [
  ['added', 'Added'],
  ['changed', 'Changed'],
  ['removed', 'Removed'],
]

const date = (s: string) => new Date(s).toLocaleString()

/**
 * Everything that changed between two snapshots of the contract, by
 * datacenter. Without a comparison loaded it offers to load one.
 */
export function Changes({
  model,
  diff,
  onCompare,
  onSelect,
}: {
  model: Model
  diff?: Diff
  /** A snapshot to compare with; undefined stops comparing. */
  onCompare: (other?: Model) => void
  onSelect: (id: string) => void
}) {
  const [types, setTypes] = useState<Set<ChangeType>>(new Set(['added', 'changed', 'removed']))
  const [kind, setKind] = useState<NodeKind | ''>('')
  const [picking, setPicking] = useState(false)

  const groups = useMemo(() => {
    const out = new Map<string, Change[]>()
    for (const c of diff?.changes ?? []) {
      if (!types.has(c.type) || (kind && c.node.kind !== kind)) continue
      const key = c.node.kind === 'datacenter' ? c.node.name : (c.dcName ?? 'Contract-wide')
      out.set(key, [...(out.get(key) ?? []), c])
    }
    return [...out].sort((a, b) => (a[0] === 'Contract-wide' ? 1 : b[0] === 'Contract-wide' ? -1 : a[0].localeCompare(b[0])))
  }, [diff, types, kind])

  if (!diff || picking) {
    return (
      <div className="changes">
        <h1>Changes</h1>
        <p className="lead">
          Compare this snapshot with an older one of the same contract to see what was added, removed or changed in between: servers, NICs
          and IPs, firewall rules, LANs, Cross Connects, labels, and more. New and changed resources are then also marked in the diagram and
          in search (<code>is:added</code>, <code>is:changed</code>).
        </p>
        <ComparePicker model={model} onLoaded={(m) => (setPicking(false), onCompare(m))} />
        {picking && (
          <button className="btn small" onClick={() => setPicking(false)}>
            Cancel
          </button>
        )}
      </div>
    )
  }

  const kinds = [...new Set(diff.changes.map((c) => c.node.kind))].sort((a, b) => KINDS[a].order - KINDS[b].order)
  const toggle = (t: ChangeType) =>
    setTypes((s) => {
      const n = new Set(s)
      if (n.has(t)) n.delete(t)
      else n.add(t)
      return n
    })
  const { older, newer } = diff

  return (
    <div className="changes">
      <h1>Changes</h1>
      <p className="lead">
        From {date(older.manifest.createdAt)} to {date(newer.manifest.createdAt)} (
        {timeBetween(older.manifest.createdAt, newer.manifest.createdAt)}). The open snapshot is the newer one.
      </p>
      <div className="row changes-bar">
        {TYPES.map(([t, label]) => (
          <button key={t} className={`chip ${t}`} aria-pressed={types.has(t)} onClick={() => toggle(t)}>
            {label} <strong>{diff.counts[t]}</strong>
          </button>
        ))}
        <select value={kind} onChange={(e) => setKind(e.target.value as NodeKind | '')} aria-label="Kind of resource">
          <option value="">All kinds</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {KINDS[k].plural}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <button className="btn small" onClick={() => setPicking(true)}>
          Compare with another…
        </button>
        <button className="btn small" onClick={() => onCompare(undefined)}>
          Stop comparing
        </button>
      </div>

      {diff.changes.length === 0 && <div className="empty">Nothing changed between these snapshots.</div>}
      {diff.changes.length > 0 && groups.length === 0 && <div className="empty">No changes match the filter.</div>}
      {groups.map(([dc, list]) => (
        <section className="location" key={dc}>
          <h2>
            {dc} <span className="count">{list.length}</span>
          </h2>
          <ul className="section change-list">
            {list.map((c) => (
              <ChangeRow key={`${c.type}:${c.id}`} change={c} onSelect={onSelect} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function ChangeRow({ change: c, onSelect }: { change: Change; onSelect: (id: string) => void }) {
  const n = c.node
  const head = (
    <>
      <KindBadge kind={n.kind} />
      <span className="name">{n.name}</span>
      {c.parentName && <span className="ctx">of {c.parentName}</span>}
      <span className={`chg-pill ${c.type}`}>{c.type}</span>
    </>
  )
  const summary = c.type !== 'changed' ? [n.subtype, n.ips.slice(0, 3).join(', ')].filter(Boolean).join(' · ') : undefined
  return (
    <li className={`change ${c.type}`}>
      {c.type === 'removed' ? (
        <div className="change-head" title="No longer in the open snapshot">
          {head}
        </div>
      ) : (
        <button className="change-head" onClick={() => onSelect(n.id)}>
          {head}
        </button>
      )}
      {summary && <div className="change-summary">{summary}</div>}
      <ChangeFields fields={c.fields} />
      {c.modified && <div className="change-summary">Modified {c.modified}</div>}
    </li>
  )
}

export function ChangeFields({ fields }: { fields: FieldChange[] }) {
  if (!fields.length) return null
  return (
    <dl className="change-fields">
      {fields.map((f, i) => (
        <div key={i}>
          <dt>{f.field}</dt>
          <dd>
            {f.before !== undefined && <del>{f.before}</del>}
            {f.before !== undefined && f.after !== undefined && <span aria-hidden> → </span>}
            {f.after !== undefined && <ins>{f.after}</ins>}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** Loads the snapshot to compare with: a file (encrypted ones too) or, for the demo, its older version. */
function ComparePicker({ model, onLoaded }: { model: Model; onLoaded: (m: Model) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [locked, setLocked] = useState<Uint8Array>()
  const [secret, setSecret] = useState('')
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  async function load(data: Uint8Array, key?: string) {
    setBusy(true)
    setError(undefined)
    try {
      const other = buildModel(await loadSnapshot(data, key))
      const [a, b] = [model.manifest, other.manifest]
      if (a.contract?.number !== b.contract?.number) {
        throw new Error(`That snapshot is of contract ${b.contract?.number ?? '?'}, the open one of contract ${a.contract?.number ?? '?'}.`)
      }
      if (a.createdAt === b.createdAt) throw new Error('That is the same snapshot as the open one.')
      setLocked(undefined)
      onLoaded(other)
    } catch (e) {
      if (e instanceof EncryptedSnapshotError) {
        setLocked(data)
        if (key !== undefined) setError(e.message)
      } else setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  async function file(f?: File) {
    if (!f) return
    const data = new Uint8Array(await f.arrayBuffer())
    if (isEncrypted(data)) {
      setLocked(data)
      setError(undefined)
    } else await load(data)
  }

  return (
    <div className="compare-picker">
      <div
        className={`drop${over ? ' over' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          void file(e.dataTransfer.files[0])
        }}
      >
        {busy ? 'Loading…' : 'Drop the other snapshot (.ionx or .ionx.age) here, or click to choose it'}
      </div>
      <input
        ref={input}
        type="file"
        accept=".ionx,.age"
        hidden
        aria-label="Snapshot to compare with"
        onChange={(e) => {
          void file(e.target.files?.[0])
          e.target.value = ''
        }}
      />
      <p className="hint">
        If the file you choose is newer than the open snapshot, it becomes the open one and the changes are shown up to it. It is read in
        this browser only.
      </p>
      {locked && (
        <form
          className="secret"
          onSubmit={(e) => {
            e.preventDefault()
            void load(locked, secret)
          }}
        >
          <label htmlFor="compare-secret">This snapshot is encrypted. Enter the passphrase or an age identity (AGE-SECRET-KEY-1…).</label>
          <input
            id="compare-secret"
            type="password"
            autoFocus
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
          <div>
            <button className="btn primary" type="submit" disabled={busy || !secret}>
              {busy ? 'Decrypting…' : 'Decrypt'}
            </button>
          </div>
        </form>
      )}
      {model.manifest.synthetic && (
        <div className="row">
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              const res = await fetch(previousDemoUrl)
              await load(new Uint8Array(await res.arrayBuffer()))
            }}
          >
            Compare with the demo two weeks earlier
          </button>
        </div>
      )}
      {error && (
        <div className="notice" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
