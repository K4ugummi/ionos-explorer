import { useId, useRef, useState, type FormEvent } from 'react'
import { download, parseRecipients, snapshotFileName, type Encryption } from '../backend/snapshots'
import type { BackendApi } from '../backend/useBackend'
import type { Manifest } from '../snapshot/types'
import { Dialog } from './Dialog'
import { FetchPanel } from './FetchPanel'

/** "Refresh": fetch again; closing it lets a running fetch go on (the top bar shows it). */
export function RefreshDialog({ api, onClose }: { api: BackendApi; onClose: () => void }) {
  return (
    <Dialog title="Fetch from IONOS again" onClose={onClose}>
      <FetchPanel api={api} refresh />
    </Dialog>
  )
}

/**
 * Saves the fetched snapshot as a file, optionally age-encrypted in the
 * browser. Until then it exists only in this page's memory.
 */
export function DownloadDialog({ data, manifest, onClose }: { data: Uint8Array; manifest: Manifest; onClose: () => void }) {
  const id = useId()
  const [kind, setKind] = useState<Encryption['kind']>('none')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const pass = useRef<HTMLInputElement>(null)
  const pass2 = useRef<HTMLInputElement>(null)
  const recipients = useRef<HTMLTextAreaElement>(null)
  const name = snapshotFileName(manifest, kind !== 'none')

  async function save(e: FormEvent) {
    e.preventDefault()
    setError(undefined)
    let enc: Encryption = { kind: 'none' }
    if (kind === 'passphrase') {
      const p = pass.current?.value ?? ''
      if (p !== (pass2.current?.value ?? '')) return setError('The two passphrases differ.')
      enc = { kind, passphrase: p }
    } else if (kind === 'recipients') {
      enc = { kind, recipients: parseRecipients(recipients.current?.value ?? '') }
    }
    setBusy(true)
    try {
      const file = enc.kind === 'none' ? data : await (await import('../backend/encrypt')).encryptSnapshot(data, enc)
      download(file, name)
      for (const input of [pass.current, pass2.current]) if (input) input.value = ''
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title="Download snapshot" onClose={onClose}>
      <form className="download-form" onSubmit={(e) => void save(e)}>
        <p className="hint">
          The fetched snapshot is only in this page&apos;s memory. Saved as a file it can be opened again or compared later. It holds IPs,
          names and firewall rules: encrypt it if it leaves this computer.
        </p>
        <fieldset>
          <legend>Encryption</legend>
          {(
            [
              ['none', 'None (.ionx)'],
              ['passphrase', 'Passphrase (.ionx.age)'],
              ['recipients', 'age recipients (.ionx.age)'],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="check">
              <input type="radio" name={`${id}-enc`} checked={kind === k} onChange={() => setKind(k)} /> {label}
            </label>
          ))}
        </fieldset>
        {kind === 'passphrase' && (
          <>
            <label htmlFor={`${id}-p1`}>Passphrase</label>
            <input id={`${id}-p1`} ref={pass} className="fetch-input" type="password" autoComplete="new-password" required autoFocus />
            <label htmlFor={`${id}-p2`}>Passphrase again</label>
            <input id={`${id}-p2`} ref={pass2} className="fetch-input" type="password" autoComplete="new-password" required />
          </>
        )}
        {kind === 'recipients' && (
          <>
            <label htmlFor={`${id}-r`}>Recipients (age1…, one per line)</label>
            <textarea id={`${id}-r`} ref={recipients} className="fetch-input" rows={3} spellCheck={false} required autoFocus />
          </>
        )}
        <div className="row">
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'Encrypting…' : 'Download'}
          </button>
          <span className="hint download-name">{name}</span>
        </div>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
      </form>
    </Dialog>
  )
}
