import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { accountLink, BackendError, Client, type LoginMethods } from '../backend/backend'
import type { BackendApi } from '../backend/useBackend'

// Hosted mode: logging in, the links that create the first admin or set a
// password, and the password change an account must make first. After a
// login the page reloads: the server then serves it with the session key
// (and the address keeps the view the user came for).

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Reloads the page, as logged in; a used link leaves the address first. */
function enter(dropLink: boolean) {
  if (dropLink) window.history.replaceState(null, '', window.location.pathname + window.location.search)
  window.location.reload()
}

export function LoginScreen({ client = new Client() }: { client?: Client }) {
  const link = accountLink(window.location.hash)
  return (
    <div className="open">
      <div className="open-card login-card">
        <h1>IONOS Explorer</h1>
        {link?.kind === 'setup' ? (
          <SetupForm client={client} code={link.code} />
        ) : link ? (
          <LinkForm client={client} code={link.code} />
        ) : (
          <LoginForm client={client} />
        )}
      </div>
    </div>
  )
}

function LoginForm({ client }: { client: Client }) {
  const id = useId()
  const [methods, setMethods] = useState<LoginMethods>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [ticket, setTicket] = useState<string>()
  const user = useRef<HTMLInputElement>(null)
  const pass = useRef<HTMLInputElement>(null)
  useEffect(() => {
    client.loginMethods().then(setMethods, (e: unknown) => setError(`The server does not answer: ${message(e)}`))
  }, [client])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      const res = await client.login(user.current?.value ?? '', pass.current?.value ?? '')
      if (res.secondFactor && res.ticket) {
        setTicket(res.ticket)
        setBusy(false)
        return
      }
      enter(false)
    } catch (err) {
      setError(message(err))
      if (pass.current) pass.current.value = ''
      pass.current?.focus()
      setBusy(false)
    }
  }

  if (!methods) return error ? <Alert text={error} /> : <p className="hint">Connecting…</p>
  if (ticket) return <CodeForm client={client} ticket={ticket} onRestart={() => setTicket(undefined)} />
  return (
    <>
      <p>Log in to search and browse your IONOS Cloud contract.</p>
      {methods.setup && (
        <div className="notice" role="status">
          There are no accounts yet. The server&apos;s log (<code>docker logs</code>, <code>kubectl logs</code>) has a link that creates the
          first admin.
        </div>
      )}
      {methods.local && (
        <form className="login-form" onSubmit={submit} aria-label="Log in">
          <label htmlFor={`${id}-user`}>Username</label>
          <input
            id={`${id}-user`}
            ref={user}
            className="fetch-input"
            autoComplete="username"
            autoCapitalize="off"
            spellCheck={false}
            required
          />
          <label htmlFor={`${id}-pass`}>Password</label>
          <input id={`${id}-pass`} ref={pass} className="fetch-input" type="password" autoComplete="current-password" required />
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? 'Logging in…' : 'Log in'}
            </button>
          </div>
        </form>
      )}
      {methods.providers.length > 0 && (
        <div className="login-providers">
          {methods.local && <h2 className="open-or">Or</h2>}
          {methods.providers.map((p) =>
            p.unavailable ? (
              <button key={p.url} type="button" className="btn" disabled>
                Log in with {p.label} (cannot be reached right now)
              </button>
            ) : (
              <a key={p.url} className="btn" href={p.url}>
                Log in with {p.label}
              </a>
            ),
          )}
        </div>
      )}
      {error && <Alert text={error} />}
    </>
  )
}

/** The second step of a login: a code from the authenticator app, or a recovery code. */
function CodeForm({ client, ticket, onRestart }: { client: Client; ticket: string; onRestart: () => void }) {
  const id = useId()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [expired, setExpired] = useState(false)
  const code = useRef<HTMLInputElement>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      await client.loginCode(ticket, code.current?.value ?? '')
      enter(false)
    } catch (err) {
      setError(message(err))
      setExpired(err instanceof BackendError && err.status === 410)
      if (code.current) code.current.value = ''
      code.current?.focus()
      setBusy(false)
    }
  }

  return (
    <>
      <p>Enter the 6-digit code from your authenticator app.</p>
      <form className="login-form" onSubmit={submit} aria-label="Second factor">
        <label htmlFor={`${id}-code`}>Code</label>
        <input
          id={`${id}-code`}
          ref={code}
          className="fetch-input totp-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={20}
          autoFocus
          required
        />
        <span className="hint">Phone lost? Enter one of your recovery codes instead (each works once).</span>
        <div className="row">
          {!expired && (
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? 'Checking…' : 'Log in'}
            </button>
          )}
          <button type="button" className={expired ? 'btn primary' : 'btn'} onClick={onRestart}>
            Start over
          </button>
        </div>
        {error && <Alert text={error} />}
      </form>
    </>
  )
}

function SetupForm({ client, code }: { client: Client; code: string }) {
  const id = useId()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [used, setUsed] = useState<boolean>()
  const user = useRef<HTMLInputElement>(null)
  const name = useRef<HTMLInputElement>(null)
  useEffect(() => {
    client.loginMethods().then(
      (m) => setUsed(!m.setup),
      () => setUsed(false), // the form will say what is wrong
    )
  }, [client])

  if (used === undefined) return <p className="hint">Checking the link…</p>
  if (used)
    return (
      <>
        <p>The first admin exists already, so this setup link is used up.</p>
        <a className="btn" href="./">
          Go to the login
        </a>
      </>
    )
  return (
    <>
      <p>Create the first admin. This account can add the other users.</p>
      <PasswordForm
        label="Create the first admin"
        submit="Create and log in"
        busy={busy}
        error={error}
        onSubmit={async (password) => {
          setBusy(true)
          setError(undefined)
          try {
            await client.setup(code, user.current?.value ?? '', name.current?.value ?? '', password)
            enter(true)
          } catch (err) {
            setError(message(err))
            setBusy(false)
          }
        }}
      >
        <label htmlFor={`${id}-user`}>Username</label>
        <input
          id={`${id}-user`}
          ref={user}
          className="fetch-input"
          autoComplete="username"
          autoCapitalize="off"
          spellCheck={false}
          required
        />
        <label htmlFor={`${id}-name`}>Name (optional, shown instead of the username)</label>
        <input id={`${id}-name`} ref={name} className="fetch-input" autoComplete="name" />
      </PasswordForm>
    </>
  )
}

function LinkForm({ client, code }: { client: Client; code: string }) {
  const [who, setWho] = useState<{ username: string; name?: string }>()
  const [error, setError] = useState<string>()
  const [invalid, setInvalid] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    client.linkInfo(code).then(setWho, (e: unknown) => {
      setError(message(e))
      setInvalid(true)
    })
  }, [client, code])

  if (invalid)
    return (
      <>
        <Alert text={error ?? ''} />
        <p className="hint">Ask an admin for a new link.</p>
        <a className="btn" href="./">
          Go to the login
        </a>
      </>
    )
  if (!who) return <p className="hint">Checking the link…</p>
  return (
    <>
      <p>
        Choose a password for <strong>{who.name || who.username}</strong> (username <code>{who.username}</code>).
      </p>
      <PasswordForm
        label="Set your password"
        submit="Set password and log in"
        username={who.username}
        busy={busy}
        error={error}
        onSubmit={async (password) => {
          setBusy(true)
          setError(undefined)
          try {
            await client.useLink(code, password)
            enter(true)
          } catch (err) {
            setError(message(err))
            setBusy(false)
          }
        }}
      />
    </>
  )
}

/** The account must change its password before anything else (the first admin from a password file). */
export function ChangePasswordScreen({ api }: { api: BackendApi }) {
  const status = api.backend.kind === 'ready' ? api.backend.status : undefined
  return (
    <div className="open">
      <div className="open-card login-card">
        <h1>Choose a new password</h1>
        <p>
          {status?.user ? <strong>{status.user}</strong> : 'This account'} has a password that was set for it. Choose your own to go on.
        </p>
        <ChangePassword api={api} />
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

/** Changes the own password (current one required); the other sessions end. */
export function ChangePassword({ api, onDone }: { api: BackendApi; onDone?: () => void }) {
  const id = useId()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const current = useRef<HTMLInputElement>(null)
  return (
    <PasswordForm
      label="Change password"
      submit="Change password"
      busy={busy}
      error={error}
      onSubmit={async (password) => {
        setBusy(true)
        setError(undefined)
        try {
          api.apply(await api.client.changePassword(current.current?.value ?? '', password))
          if (current.current) current.current.value = ''
          onDone?.()
        } catch (err) {
          setError(message(err))
        } finally {
          setBusy(false)
        }
      }}
    >
      <label htmlFor={`${id}-current`}>Current password</label>
      <input id={`${id}-current`} ref={current} className="fetch-input" type="password" autoComplete="current-password" required />
    </PasswordForm>
  )
}

/**
 * A form ending in "new password" twice. The fields are uncontrolled, read
 * on submit and cleared after; the server checks the rules, the page only
 * the length and that both match.
 */
function PasswordForm({
  label,
  submit,
  username,
  busy,
  error,
  onSubmit,
  children,
}: {
  label: string
  submit: string
  /** For password managers. */
  username?: string
  busy: boolean
  error?: string
  onSubmit: (password: string) => Promise<void>
  children?: React.ReactNode
}) {
  const id = useId()
  const [mismatch, setMismatch] = useState<string>()
  const pass = useRef<HTMLInputElement>(null)
  const pass2 = useRef<HTMLInputElement>(null)
  return (
    <form
      className="login-form"
      aria-label={label}
      onSubmit={(e) => {
        e.preventDefault()
        const p = pass.current?.value ?? ''
        if (p !== pass2.current?.value) return setMismatch('The two passwords differ.')
        setMismatch(undefined)
        void onSubmit(p).then(() => {
          for (const input of [pass.current, pass2.current]) if (input) input.value = ''
        })
      }}
    >
      {username && <input type="text" autoComplete="username" value={username} readOnly hidden />}
      {children}
      <label htmlFor={`${id}-new`}>New password</label>
      <input
        id={`${id}-new`}
        ref={pass}
        className="fetch-input"
        type="password"
        autoComplete="new-password"
        minLength={12}
        maxLength={256}
        aria-describedby={`${id}-rules`}
        required
      />
      <span id={`${id}-rules`} className="hint">
        At least 12 characters; a few words make a good one. Common passwords are refused.
      </span>
      <label htmlFor={`${id}-new2`}>New password again</label>
      <input id={`${id}-new2`} ref={pass2} className="fetch-input" type="password" autoComplete="new-password" required />
      <div className="row">
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'One moment…' : submit}
        </button>
      </div>
      {(mismatch ?? error) && <Alert text={(mismatch ?? error)!} />}
    </form>
  )
}

function Alert({ text }: { text: string }) {
  return (
    <div className="error" role="alert">
      {text}
    </div>
  )
}
