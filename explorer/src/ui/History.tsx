import { useEffect, useState } from 'react'
import type { Client, HistoryEntry, HistoryList } from '../backend/backend'
import { sizeText } from '../backend/snapshots'

/** Rows shown per contract before "Show all". */
const SHOWN = 5

const when = (s: string) => new Date(s).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })

/**
 * The user's own snapshot history on the server (hosted mode with a key):
 * per contract, newest first, to open or compare with, and to delete.
 * `contract` limits it to one contract; `exclude` leaves out the open
 * snapshot (by its time). The server decrypts; nothing is kept here.
 */
export function History({
  client,
  contract,
  exclude,
  action,
  onOpen,
}: {
  client: Client
  contract?: string
  exclude?: string
  /** The button of a row: "Open" on the open screen, "Compare" in Changes. */
  action: string
  onOpen: (data: Uint8Array, entry: HistoryEntry) => Promise<void>
}) {
  const [list, setList] = useState<HistoryList>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [confirm, setConfirm] = useState<string>()
  const [all, setAll] = useState<Set<string>>(new Set())
  const [version, setVersion] = useState(0) // up: read the list again

  useEffect(() => {
    let live = true
    client.history(contract).then(
      (l) => live && setList(l),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    )
    return () => {
      live = false
    }
  }, [client, contract, version])

  const open = async (e: HistoryEntry) => {
    setBusy(e.id)
    setError(undefined)
    try {
      await onOpen(await client.historySnapshot(e.id), e)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(undefined)
    }
  }
  const remove = async (e: HistoryEntry) => {
    setBusy(e.id)
    setError(undefined)
    try {
      await client.deleteHistory(e.id)
      setConfirm(undefined)
      setVersion((v) => v + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(undefined)
    }
  }

  if (!list) return error ? <p className="hint error">{error}</p> : <p className="hint">Loading your history…</p>
  const skip = exclude ? new Date(exclude).getTime() : NaN
  const entries = list.entries.filter((e) => new Date(e.createdAt).getTime() !== skip)
  const groups = new Map<string, HistoryEntry[]>()
  for (const e of entries) groups.set(e.contract, [...(groups.get(e.contract) ?? []), e])

  return (
    <div className="history">
      {entries.length === 0 && (
        <p className="hint">
          {contract ? 'No other snapshot of this contract in your history yet.' : 'Nothing yet: every fetch is kept here, encrypted on the server.'}
        </p>
      )}
      {[...groups].map(([c, rows]) => {
        const shown = all.has(c) ? rows : rows.slice(0, SHOWN)
        return (
          <section key={c} className="history-contract" aria-label={`Contract ${c}`}>
            {!contract && (
              <div className="history-head">
                <h3>{c === 'unknown' ? 'Without contract number' : `Contract ${c}`}</h3>
                <button className="btn small primary" disabled={!!busy} onClick={() => void open(rows[0])}>
                  {busy === rows[0].id ? 'Opening…' : 'Open latest'}
                </button>
              </div>
            )}
            <ul className="history-list">
              {shown.map((e) => (
                <li key={e.id} className="history-row">
                  <span className="history-when" title={e.createdAt}>
                    {when(e.createdAt)}
                  </span>
                  <span className="history-what hint">
                    {e.collections} collections · {sizeText(e.size)}
                    {e.partial && (
                      <span className="pill warn" title={`${e.problems} could not be read`}>
                        partial
                      </span>
                    )}
                  </span>
                  <span className="history-actions">
                    {confirm === e.id ? (
                      <>
                        <span>Delete?</span>
                        <button className="btn small danger" disabled={!!busy} onClick={() => void remove(e)}>
                          {busy === e.id ? 'Deleting…' : 'Delete'}
                        </button>
                        <button className="btn small" onClick={() => setConfirm(undefined)}>
                          Keep
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="btn small" disabled={!!busy} onClick={() => void open(e)}>
                          {busy === e.id ? 'Opening…' : action}
                        </button>
                        <button
                          className="btn small"
                          disabled={!!busy}
                          onClick={() => setConfirm(e.id)}
                          aria-label={`Delete the snapshot of ${when(e.createdAt)}`}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            {rows.length > SHOWN && (
              <button
                className="btn small history-more"
                onClick={() =>
                  setAll((s) => {
                    const n = new Set(s)
                    if (n.has(c)) n.delete(c)
                    else n.add(c)
                    return n
                  })
                }
              >
                {all.has(c) ? 'Show fewer' : `Show all ${rows.length}`}
              </button>
            )}
          </section>
        )
      })}
      <p className="hint history-usage">
        {sizeText(list.used)}
        {list.quota ? ` of ${sizeText(list.quota)}` : ''} used. Older snapshots are thinned out over time (one a day, then a week, then a
        month); only you can see them.
      </p>
      {error && (
        <p className="hint error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
