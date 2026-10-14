import { useRef, useState } from 'react'
import demoUrl from '../../../fixtures/demo-contract.ionx?url'
import { buildModel } from '../model/build'
import type { Model } from '../model/types'
import { EncryptedSnapshotError, isEncrypted, loadSnapshot } from '../snapshot/load'

export function OpenScreen({ onLoaded }: { onLoaded: (m: Model) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [over, setOver] = useState(false)
  const [locked, setLocked] = useState<{ name: string; data: Uint8Array }>()
  const [secret, setSecret] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  async function open(name: string, data: Uint8Array, key?: string) {
    setBusy(true)
    setError(undefined)
    try {
      const snapshot = await loadSnapshot(data, key)
      onLoaded(buildModel(snapshot))
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
    await open('demo-contract.ionx', new Uint8Array(await res.arrayBuffer()))
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
        <p>Search and browse an entire IONOS Cloud contract from a snapshot made by <code>ionos-export</code>.</p>

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
            <input
              id="secret"
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
          Snapshots are opened locally in your browser. Nothing is uploaded, and this app never contacts the IONOS API.
        </div>
      </div>
    </div>
  )
}
