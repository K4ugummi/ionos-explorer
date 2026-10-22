import { useId, useMemo, useRef, useState, type FormEvent } from 'react'
import type { BackendStatus } from '../backend/backend'
import { download } from '../backend/snapshots'
import type { BackendApi } from '../backend/useBackend'
import { qrModules, qrPath } from './qr'

// Hosted mode, local accounts: the second factor (an authenticator app,
// TOTP). Setting it up shows a QR code drawn here from the otpauth://
// address (nothing leaves the page for it), then 10 recovery codes once.

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The QR code of text, black on white whatever the theme (scanners need the contrast). */
export function QrCode({ text, label }: { text: string; label: string }) {
  const modules = useMemo(() => qrModules(text), [text])
  const size = modules.length + 8
  return (
    <svg className="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={qrPath(modules)} fill="#000" />
    </svg>
  )
}

/** "ABCD EFGH …": the key, easier to type. */
const grouped = (key: string) => key.replace(/(.{4})/g, '$1 ').trim()

/** Sets up the second factor: QR code and key, then a code and the password. */
export function TwoFactorSetup({
  api,
  onEnabled,
  onCancel,
}: {
  api: BackendApi
  onEnabled: (codes: string[], status: BackendStatus) => void
  onCancel?: () => void
}) {
  const id = useId()
  const [secret, setSecret] = useState<{ key: string; uri: string }>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const code = useRef<HTMLInputElement>(null)
  const pass = useRef<HTMLInputElement>(null)

  async function begin() {
    setBusy(true)
    setError(undefined)
    try {
      setSecret(await api.client.totpBegin())
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  async function enable(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      const res = await api.client.totpEnable(pass.current?.value ?? '', code.current?.value ?? '')
      setSecret(undefined)
      onEnabled(res.recoveryCodes, res.status)
    } catch (err) {
      setError(message(err))
      if (code.current) code.current.value = ''
      code.current?.focus()
    } finally {
      if (pass.current) pass.current.value = ''
      setBusy(false)
    }
  }

  if (!secret)
    return (
      <div className="totp-setup">
        <p className="hint">
          After the password, the login then also asks for a code from an authenticator app on your phone (any app for one-time codes, TOTP).
        </p>
        <div className="row">
          <button type="button" className="btn primary" disabled={busy} onClick={() => void begin()}>
            {busy ? 'One moment…' : 'Set up two-factor authentication'}
          </button>
          {onCancel && (
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
        {error && <Alert text={error} />}
      </div>
    )
  return (
    <form className="login-form totp-setup" onSubmit={enable} aria-label="Set up two-factor authentication">
      <p className="hint">1. Scan this code with the authenticator app, or type in the key.</p>
      <div className="totp-qr">
        <QrCode text={secret.uri} label="QR code for the authenticator app" />
        <div>
          <span className="hint">Key</span>
          <code className="totp-key">{grouped(secret.key)}</code>
        </div>
      </div>
      <label htmlFor={`${id}-code`}>2. The 6-digit code the app shows now</label>
      <input
        id={`${id}-code`}
        ref={code}
        className="fetch-input totp-code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9 ]{6,7}"
        maxLength={7}
        required
      />
      <label htmlFor={`${id}-pass`}>3. Your password</label>
      <input id={`${id}-pass`} ref={pass} className="fetch-input" type="password" autoComplete="current-password" required />
      <div className="row">
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'One moment…' : 'Turn on'}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setSecret(undefined)
            onCancel?.()
          }}
        >
          Cancel
        </button>
      </div>
      {error && <Alert text={error} />}
    </form>
  )
}

/** The recovery codes, shown once: copy or save them, then go on. */
export function RecoveryCodes({ codes, user, onDone }: { codes: string[]; user?: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const text = `IONOS Explorer recovery codes${user ? ` for ${user}` : ''}\nEach works once instead of a code from the app.\n\n${codes.join('\n')}\n`
  return (
    <div className="notice totp-recovery" role="status">
      <p>
        <strong>Recovery codes.</strong> If the phone is lost, each of these logs you in once instead of a code from the app. They are shown
        only now: keep them somewhere safe, like a password manager.
      </p>
      <ol className="totp-codes">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ol>
      <div className="row">
        <button
          type="button"
          className="btn small"
          onClick={() =>
            navigator.clipboard?.writeText(text).then(
              () => (setCopied(true), setSaved(true)),
              () => setCopied(false),
            )
          }
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          className="btn small"
          onClick={() => {
            download(new TextEncoder().encode(text), 'ionos-explorer-recovery-codes.txt')
            setSaved(true)
          }}
        >
          Save as file
        </button>
        <label className="totp-saved">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have kept them
        </label>
        <span className="spacer" />
        <button type="button" className="btn primary" disabled={!saved} onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  )
}

/** The account dialog's part: on or off, new recovery codes, turn off. */
export function TwoFactorSection({ api, onDone }: { api: BackendApi; onDone: (text: string) => void }) {
  const id = useId()
  const [codes, setCodes] = useState<{ codes: string[]; status?: BackendStatus }>()
  const [action, setAction] = useState<'recovery' | 'off'>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const pass = useRef<HTMLInputElement>(null)
  if (api.backend.kind !== 'ready') return null
  const { totp, totpAvailable, totpRequired, user } = api.backend.status
  if (!totp && !totpAvailable && !codes) return null

  if (codes)
    return (
      <RecoveryCodes
        codes={codes.codes}
        user={user}
        onDone={() => {
          if (codes.status) api.apply(codes.status)
          setCodes(undefined)
          onDone(codes.status ? 'Two-factor authentication is on. Your other sessions have ended.' : 'New recovery codes made; the old ones no longer work.')
        }}
      />
    )

  async function submit(e: FormEvent) {
    e.preventDefault()
    const password = pass.current?.value ?? ''
    if (pass.current) pass.current.value = ''
    setBusy(true)
    setError(undefined)
    try {
      if (action === 'recovery') setCodes({ codes: await api.client.totpRecovery(password) })
      else {
        api.apply(await api.client.totpDisable(password))
        onDone('Two-factor authentication is off. Your other sessions have ended.')
      }
      setAction(undefined)
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="fetch-options account-section">
      <summary>Two-factor authentication: {totp ? 'on' : 'off'}</summary>
      {!totp ? (
        <TwoFactorSetup
          api={api}
          onEnabled={(c, status) => setCodes({ codes: c, status })}
        />
      ) : action ? (
        <form className="login-form" onSubmit={submit} aria-label={action === 'off' ? 'Turn off two-factor authentication' : 'New recovery codes'}>
          <label htmlFor={`${id}-pass`}>Your password</label>
          <input id={`${id}-pass`} ref={pass} className="fetch-input" type="password" autoComplete="current-password" required autoFocus />
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? 'One moment…' : action === 'off' ? 'Turn off' : 'Make new codes'}
            </button>
            <button type="button" className="btn" onClick={() => (setAction(undefined), setError(undefined))}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="totp-on">
          <p className="hint">The login asks for a code from your authenticator app after the password.</p>
          <div className="row">
            <button type="button" className="btn small" onClick={() => setAction('recovery')}>
              New recovery codes
            </button>
            {!totpRequired && (
              <button type="button" className="btn small" onClick={() => setAction('off')}>
                Turn off
              </button>
            )}
          </div>
        </div>
      )}
      {error && <Alert text={error} />}
    </details>
  )
}

/** The account must set up a second factor before anything else (the server requires one). */
export function EnrolScreen({ api }: { api: BackendApi }) {
  const [codes, setCodes] = useState<{ codes: string[]; status: BackendStatus }>()
  const status = api.backend.kind === 'ready' ? api.backend.status : undefined
  return (
    <div className="open">
      <div className="open-card login-card">
        <h1>Two-factor authentication</h1>
        {codes ? (
          <RecoveryCodes codes={codes.codes} user={status?.user} onDone={() => api.apply(codes.status)} />
        ) : (
          <>
            <p>
              This server asks every account for a second factor. Set it up for{' '}
              {status?.user ? <strong>{status.user}</strong> : 'your account'} to go on.
            </p>
            <TwoFactorSetup api={api} onEnabled={(c, st) => setCodes({ codes: c, status: st })} />
          </>
        )}
        <div className="row">
          <span className="spacer" />
          <button type="button" className="btn small" onClick={() => void api.logout()}>
            Log out
          </button>
        </div>
      </div>
    </div>
  )
}

function Alert({ text }: { text: string }) {
  return (
    <div className="error" role="alert">
      {text}
    </div>
  )
}
