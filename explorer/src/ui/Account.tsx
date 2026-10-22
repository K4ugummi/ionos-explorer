import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { UserAction, UserInfo } from '../backend/backend'
import type { BackendApi } from '../backend/useBackend'
import { Dialog } from './Dialog'
import { ChangePassword } from './LoginScreen'
import { TwoFactorSection } from './TwoFactor'

// Hosted mode: the logged-in user's account (password, other sessions, log
// out) and, for admins, the local user accounts.

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The user's name in the top bar or fetch panel; opens the account dialog. */
export function AccountButton({ api, className = 'btn' }: { api: BackendApi; className?: string }) {
  const [open, setOpen] = useState(false)
  if (api.backend.kind !== 'ready' || !api.backend.status.user) return null
  const { user, admin } = api.backend.status
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} title="Your account" aria-haspopup="dialog">
        {user}
        {admin && <span className="account-role">admin</span>}
      </button>
      {open && <AccountDialog api={api} onClose={() => setOpen(false)} />}
    </>
  )
}

function AccountDialog({ api, onClose }: { api: BackendApi; onClose: () => void }) {
  const [page, setPage] = useState<'account' | 'users'>('account')
  const [done, setDone] = useState<string>()
  const [error, setError] = useState<string>()
  if (api.backend.kind !== 'ready') return null
  const { user, admin, localUser } = api.backend.status

  if (page === 'users')
    return (
      <Dialog title="Users" onClose={onClose} wide>
        <button type="button" className="btn small users-back" onClick={() => setPage('account')}>
          ‹ Account
        </button>
        <Users api={api} />
      </Dialog>
    )
  return (
    <Dialog title="Account" onClose={onClose}>
      <p className="hint account-who">
        Logged in as <strong>{user}</strong>
        {admin ? ' (admin)' : ''}.
      </p>
      {localUser && (
        <details className="fetch-options account-section">
          <summary>Change password</summary>
          <ChangePassword api={api} onDone={() => setDone('Password changed. Your other sessions have ended.')} />
        </details>
      )}
      {localUser && <TwoFactorSection api={api} onDone={setDone} />}
      <div className="row account-actions">
        {admin && (
          <button type="button" className="btn" onClick={() => setPage('users')}>
            Manage users…
          </button>
        )}
        {localUser && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setError(undefined)
              api.client.logoutOthers().then(
                (st) => (api.apply(st), setDone('Your other sessions have ended.')),
                (e: unknown) => setError(message(e)),
              )
            }}
          >
            Log out other sessions
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="btn primary" onClick={() => void api.logout()}>
          Log out
        </button>
      </div>
      {done && (
        <p className="hint" role="status">
          {done}
        </p>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </Dialog>
  )
}

const when = (s?: string) => (s ? new Date(s).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : 'never')

/** The local accounts: list, add (with a link to pass on), reset, disable, role, delete. */
function Users({ api }: { api: BackendApi }) {
  const id = useId()
  const [list, setList] = useState<UserInfo[]>()
  const [error, setError] = useState<string>()
  const [link, setLink] = useState<{ username: string; url: string }>()
  const [confirm, setConfirm] = useState<string>() // id of the user whose Delete waits for a second click
  const [busy, setBusy] = useState(false)
  const username = useRef<HTMLInputElement>(null)
  const name = useRef<HTMLInputElement>(null)
  const role = useRef<HTMLSelectElement>(null)

  const load = useCallback(
    () =>
      api.client.users().then(
        (u) => setList(u),
        (e: unknown) => setError(message(e)),
      ),
    [api.client],
  )
  useEffect(() => void load(), [load])

  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setError(undefined)
    try {
      await fn()
      await load()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  const add = (e: FormEvent) => {
    e.preventDefault()
    const who = username.current?.value.trim() ?? ''
    void run(async () => {
      const res = await api.client.addUser(who, name.current?.value ?? '', (role.current?.value as UserInfo['role']) ?? 'user')
      setLink({ username: who.toLowerCase(), url: res.link })
      if (username.current) username.current.value = ''
      if (name.current) name.current.value = ''
    })
  }
  const act = (u: UserInfo, action: UserAction, newRole?: UserInfo['role']) =>
    run(async () => {
      setConfirm(undefined)
      const res = await api.client.changeUser(action, u.id, newRole)
      setLink(res.link ? { username: u.username, url: res.link } : undefined)
    })

  return (
    <div className="users">
      {link && <LinkBox username={link.username} url={link.url} onClose={() => setLink(undefined)} />}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {!list ? (
        <p className="hint">Loading…</p>
      ) : (
        <ul className="user-list" aria-label="User accounts">
          {list.map((u) => (
            <li key={u.id} className="user-row">
              <div className="user-who">
                <strong>{u.name || u.username}</strong>
                {u.name && <span className="hint"> {u.username}</span>}
                {u.you && <span className="pill">you</span>}
                <span className="pill">{u.role}</span>
                {u.disabled && <span className="pill warn">disabled</span>}
                {u.pending && <span className="pill warn">no password yet</span>}
                {u.mustChangePassword && <span className="pill">must change password</span>}
                {u.locked && <span className="pill warn">delayed after failed logins</span>}
                {u.totp && <span className="pill">two-factor</span>}
              </div>
              <div className="hint user-last">Last login: {when(u.lastLogin)}</div>
              {!u.you && (
                <div className="user-actions">
                  <button
                    type="button"
                    className="btn small"
                    disabled={busy}
                    onClick={() => void act(u, 'reset')}
                    title="Remove the password and end the sessions; gives a new link"
                  >
                    Reset password
                  </button>
                  {u.totp && (
                    <button
                      type="button"
                      className="btn small"
                      disabled={busy}
                      onClick={() => void act(u, 'reset-totp')}
                      title="Remove the second factor (a lost phone) and end the sessions; they set up a new one after logging in"
                    >
                      Reset two-factor
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn small"
                    disabled={busy}
                    onClick={() => void act(u, u.disabled ? 'enable' : 'disable')}
                  >
                    {u.disabled ? 'Enable' : 'Disable'}
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    disabled={busy}
                    onClick={() => void act(u, 'role', u.role === 'admin' ? 'user' : 'admin')}
                  >
                    {u.role === 'admin' ? 'Make user' : 'Make admin'}
                  </button>
                  {confirm === u.id ? (
                    <button type="button" className="btn small danger" disabled={busy} onClick={() => void act(u, 'delete')}>
                      Really delete {u.username}?
                    </button>
                  ) : (
                    <button type="button" className="btn small" disabled={busy} onClick={() => setConfirm(u.id)}>
                      Delete
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <form className="login-form user-add" onSubmit={add} aria-label="Add a user">
        <h3>Add a user</h3>
        <label htmlFor={`${id}-user`}>Username</label>
        <input
          id={`${id}-user`}
          ref={username}
          className="fetch-input"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          pattern="[A-Za-z0-9._@\-]{1,64}"
          title="1 to 64 letters, digits and . _ @ -"
          required
        />
        <label htmlFor={`${id}-name`}>Name (optional)</label>
        <input id={`${id}-name`} ref={name} className="fetch-input" autoComplete="off" />
        <label htmlFor={`${id}-role`}>Role</label>
        <select id={`${id}-role`} ref={role} className="fetch-input" defaultValue="user">
          <option value="user">User: fetches and explores</option>
          <option value="admin">Admin: also manages users</option>
        </select>
        <div className="row">
          <button className="btn primary" type="submit" disabled={busy}>
            Add and make a link
          </button>
        </div>
        <p className="hint">
          The new user sets a password with a one-time link, valid 24 hours. This explorer sends no mail: pass the link on yourself.
        </p>
      </form>
    </div>
  )
}

/** A one-time link to pass on, with Copy. */
function LinkBox({ username, url, onClose }: { username: string; url: string; onClose: () => void }) {
  const id = useId()
  const [copied, setCopied] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="notice link-box" role="status">
      <label htmlFor={id}>
        Pass this link on to <strong>{username}</strong> (once, within 24 hours):
      </label>
      <div className="row">
        <input id={id} ref={input} className="fetch-input" readOnly value={url} onFocus={(e) => e.target.select()} />
        <button
          type="button"
          className="btn small"
          onClick={() => {
            input.current?.select()
            navigator.clipboard?.writeText(url).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="btn small" onClick={onClose} aria-label="Hide the link">
          ✕
        </button>
      </div>
    </div>
  )
}
