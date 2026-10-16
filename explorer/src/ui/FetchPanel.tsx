import { useId, useRef, type FormEvent } from 'react'
import { parseSkip, progressText } from '../backend/backend'
import type { BackendApi } from '../backend/useBackend'

const time = (s: string) => new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/**
 * Fetch the contract through the local ionos-explorer program. The token
 * field is uncontrolled: its value is read once on submit, cleared at once
 * and sent to the program; it never becomes React state.
 */
export function FetchPanel({ api, refresh = false }: { api: BackendApi; refresh?: boolean }) {
  const { backend, busy, error, notice } = api
  const id = useId()
  const tokenInput = useRef<HTMLInputElement>(null)
  const keepInput = useRef<HTMLInputElement>(null)
  const skipInput = useRef<HTMLInputElement>(null)
  const contractInput = useRef<HTMLInputElement>(null)

  if (backend.kind === 'none') return null
  if (backend.kind === 'checking') return <div className="fetch-panel hint">Connecting to ionos-explorer…</div>
  if (backend.kind === 'no-session' || backend.kind === 'unreachable') {
    return (
      <div className="fetch-panel">
        <div className="notice" role="status">
          {backend.kind === 'no-session'
            ? 'This tab is not logged in to ionos-explorer. To fetch from IONOS here, open the link the program printed when it started.'
            : 'ionos-explorer does not answer. Is it still running? Snapshot files can still be opened.'}
        </div>
      </div>
    )
  }

  const { status } = backend
  const f = status.fetch
  const running = f?.state === 'running'
  const waiting = !running && f?.resultReady && !busy

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const input = tokenInput.current
    const token = input?.value.trim() ?? ''
    if (input) input.value = '' // not kept in the page
    void api.start({
      token: token || undefined,
      keep: keepInput.current?.checked ?? true,
      skip: parseSkip(skipInput.current?.value ?? ''),
      contractNumber: contractInput.current?.value.trim() || undefined,
    })
  }

  return (
    <form className="fetch-panel" onSubmit={submit} aria-label={refresh ? 'Fetch again' : 'Fetch from IONOS'}>
      {!refresh && <h2>Fetch from IONOS</h2>}
      <p className="hint">
        {refresh
          ? 'Fetches the contract again. The open snapshot becomes the one to compare with, so the Changes tab shows what changed.'
          : 'This program reads your contract with GET requests only. The token goes to it alone and stays in its memory; the data stays in memory until you download it.'}
      </p>

      {status.tokenHeld ? (
        <div className="fetch-token">
          <span>
            An API token is held in memory
            {status.tokenForgetAt ? ` (forgotten at ${time(status.tokenForgetAt)} if unused)` : ''}.
          </span>
          <button type="button" className="btn small" onClick={() => void api.forget()} disabled={busy}>
            Forget token
          </button>
        </div>
      ) : (
        <>
          <label htmlFor={`${id}-token`}>IONOS API token</label>
          <input
            id={`${id}-token`}
            ref={tokenInput}
            className="fetch-input"
            type="password"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            required
            disabled={running}
          />
          <label className="check">
            <input ref={keepInput} type="checkbox" defaultChecked disabled={running} /> Keep the token in memory for Refresh (until Forget,
            exit or 30 minutes unused)
          </label>
        </>
      )}

      <details className="fetch-options">
        <summary>Options</summary>
        <label htmlFor={`${id}-skip`}>Leave out (endpoint paths, prefixes or API ids)</label>
        <input id={`${id}-skip`} ref={skipInput} className="fetch-input" placeholder="/um vpn" disabled={running} spellCheck={false} />
        <label htmlFor={`${id}-contract`}>Contract number (only for users with several)</label>
        <input id={`${id}-contract`} ref={contractInput} className="fetch-input" inputMode="numeric" pattern="[0-9]*" disabled={running} />
      </details>

      {running ? (
        <div className="fetch-progress" role="status">
          <progress value={f.done} max={Math.max(f.total, 1)} aria-label="Fetch progress" />
          <div className="row">
            <span>Fetching… {progressText(f)}</span>
            <span className="spacer" />
            <button type="button" className="btn small" onClick={() => void api.cancel()} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="row">
          <button className="btn primary" type="submit" disabled={busy}>
            {busy && f?.resultReady ? 'Opening…' : refresh ? 'Fetch again' : 'Fetch'}
          </button>
          {notice && <span className="hint">{notice}</span>}
        </div>
      )}

      {waiting && (
        <div className="row">
          <span className="hint">A fetched snapshot is waiting.</span>
          <button type="button" className="btn small" onClick={() => void api.takeWaiting()}>
            Open it
          </button>
        </div>
      )}

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </form>
  )
}
