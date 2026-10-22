import { useRef, useState } from 'react'
// Small enough to bundle; the CSP would refuse fetching an inlined data: URL.
import demoLinks from '../../../fixtures/demo-annotations.json'
import demoUrl from '../../../fixtures/demo-contract.ionx?url'
import { parse, type Annotations } from '../annotations/annotations'
import { buildModel } from '../model/build'
import type { Model } from '../model/types'
import { EncryptedSnapshotError, isEncrypted, loadSnapshot } from '../snapshot/load'
import type { BackendApi } from '../backend/useBackend'
import { FetchPanel } from './FetchPanel'
import { History } from './History'

/** A snapshot opened from the history on the server: its bytes (to download) and ID. */
export interface FromHistory {
  data: Uint8Array
  historyId: string
}

/**
 * `demoLinks`: example manual links that come with the demo snapshot.
 * `backend`: ionos-explorer, when it served this page (the fetch panel shows only then;
 * hosted with a history, the user's history too).
 */
export function OpenScreen({
  backend,
  onLoaded,
}: {
  backend: BackendApi
  onLoaded: (m: Model, demoLinks?: Annotations, stored?: FromHistory) => void
}) {
  const local = backend.backend.kind !== 'none'
  const history = backend.backend.kind === 'ready' && !!backend.backend.status.history
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [over, setOver] = useState(false)
  const [locked, setLocked] = useState<{ name: string; data: Uint8Array }>()
  const [secret, setSecret] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  async function open(name: string, data: Uint8Array, key?: string, demoLinks?: Annotations) {
    setBusy(true)
    setError(undefined)
    try {
      const snapshot = await loadSnapshot(data, key)
      onLoaded(buildModel(snapshot), demoLinks)
    } catch (e) {
      if (e instanceof EncryptedSnapshotError) {
        setLocked({ name, data })
        if (key !== undefined) setError(e.message)
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setBusy(false)
    }
  }

  async function openFile(file: File | undefined) {
    if (!file) return
    setLocked(undefined)
    setSecret('')
    const data = new Uint8Array(await file.arrayBuffer())
    if (isEncrypted(data)) {
      setLocked({ name: file.name, data })
      setError(undefined)
      return
    }
    await open(file.name, data)
  }

  async function openDemo() {
    setLocked(undefined)
    const res = await fetch(demoUrl)
    await open('demo-contract.ionx', new Uint8Array(await res.arrayBuffer()), undefined, parse(demoLinks).annotations)
  }

  return (
    <div
      className="open"
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        void openFile(e.dataTransfer.files[0])
      }}
    >
      <div className="open-card">
        <h1>IONOS Explorer</h1>
        <p>
          {local ? (
            'Search and browse an entire IONOS Cloud contract: fetch it now, or open a snapshot file.'
          ) : (
            <>
              Search and browse an entire IONOS Cloud contract from a snapshot made by <code>ionos-export</code>.
            </>
          )}
        </p>

        {local && (
          <>
            <FetchPanel api={backend} />
            {history && (
              <>
                <h2 className="open-or">Your history</h2>
                <History
                  client={backend.client}
                  action="Open"
                  onOpen={async (data, e) => onLoaded(buildModel(await loadSnapshot(data)), undefined, { data, historyId: e.id })}
                />
              </>
            )}
            <h2 className="open-or">Open a snapshot file</h2>
          </>
        )}

        <div
          className={`drop${over ? ' over' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => fileInput.current?.click()}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileInput.current?.click()}
        >
          {busy ? 'Loading…' : 'Drop a snapshot (.ionx or .ionx.age) here, or click to choose a file'}
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".ionx,.age"
          hidden
          onChange={(e) => {
            void openFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />

        {locked && (
          <form
            className="secret"
            onSubmit={(e) => {
              e.preventDefault()
              void open(locked.name, locked.data, secret)
            }}
          >
            <label htmlFor="secret">
              <strong>{locked.name}</strong> is encrypted. Enter the passphrase or an age identity (AGE-SECRET-KEY-1…).
            </label>
            <input id="secret" type="password" autoFocus autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
            <div>
              <button className="btn primary" type="submit" disabled={busy || !secret}>
                {busy ? 'Decrypting…' : 'Decrypt'}
              </button>
            </div>
          </form>
        )}

        <div className="open-actions">
          <button className="btn" onClick={() => void openDemo()} disabled={busy}>
            Load demo snapshot
          </button>
          <span className="pill">synthetic data, 14 datacenters</span>
        </div>

        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}

        <div className="fine">
          {backend.hosted && history
            ? 'Files are opened in this browser and not uploaded. Fetching runs on the ionos-explorer server, which sends GET requests only and keeps your token in memory for your session; what it fetches is kept encrypted in your history there.'
            : backend.hosted
            ? 'Files are opened in this browser and not uploaded. Fetching runs on the ionos-explorer server, which sends GET requests only and keeps your token and data in memory for your session.'
            : local
              ? 'Files are opened in this browser and not uploaded. Fetching runs in the ionos-explorer program on this computer, which sends GET requests only and keeps the token and the data in memory.'
              : 'Snapshots are opened locally in your browser. Nothing is uploaded, and this page never contacts the IONOS API.'}
        </div>
      </div>
    </div>
  )
}
