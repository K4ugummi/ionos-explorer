// The server of ionos-explorer (exporter/internal/server), when the explorer
// is served by it: fetch the contract from the IONOS API there. It runs on
// the user's machine (local mode) or for a team (hosted mode). Without it
// (static build, `npm run dev`) none of this is used and no request is made.
//
// Requests use relative URLs (`api/status`): in hosted mode the page may
// live below a path (https://tools.example.com/ionos-explorer/).

/** The header that carries the session key; see server.Header. */
export const HEADER = 'X-Ionos-Explorer'
/** Where the page keeps the session key: per tab and per origin (port included). */
export const STORAGE_KEY = 'ionos-explorer:session'
/** The server marks the index.html it serves with this meta tag: `local-server` or `hosted`. */
export const META = 'ionos-explorer'
/** In hosted mode, the session key comes with the page (every tab of a logged-in browser has it). */
export const SESSION_META = 'ionos-explorer-session'

export type FetchState = 'running' | 'done' | 'failed' | 'cancelled'

export interface FetchStatus {
  state: FetchState
  /** Collection requests finished and planned so far (the plan grows once the top-level lists are in). */
  done: number
  total: number
  /** Requests that could not be read (forbidden, missing, failed). */
  problems: number
  error?: string
  resultReady: boolean
  size?: number
  startedAt: string
  finishedAt?: string
  /** Hosted with a history: the snapshot's ID there, or why it could not be stored. */
  historyId?: string
  historyError?: string
}

export interface BackendStatus {
  app: 'ionos-explorer'
  version: string
  tokenHeld: boolean
  tokenForgetAt?: string
  fetch?: FetchStatus
  /** Hosted mode: who is logged in; an admin; a local account (with a password here); must change it first. */
  user?: string
  admin?: boolean
  localUser?: boolean
  mustChangePassword?: boolean
  /** Hosted mode: every fetch is kept, encrypted, in the user's own history on the server. */
  history?: boolean
  /** Local accounts' second factor: set up; offered here; must be set up first; cannot be turned off here. */
  totp?: boolean
  totpAvailable?: boolean
  mustEnrollTotp?: boolean
  totpRequired?: boolean
}

/** A snapshot in the user's history (server: history.Entry). */
export interface HistoryEntry {
  id: string
  /** The contract number, or `unknown`. */
  contract: string
  createdAt: string
  collections: number
  problems: number
  partial: boolean
  /** Bytes of the snapshot, and what it takes on the server (encrypted). */
  size: number
  stored: number
  version?: string
}

export interface HistoryList {
  entries: HistoryEntry[]
  used: number
  /** The most the history may take; absent: no limit. */
  quota?: number
}

/** Hosted mode, before login: how users log in. */
export interface LoginMethods {
  app: 'ionos-explorer'
  /** Username and password. */
  local: boolean
  /** No account yet: the first admin comes from the link in the server's log. */
  setup?: boolean
  /** OIDC providers, one button each; unavailable: its identity provider has not answered yet. */
  providers: { label: string; url: string; unavailable?: boolean }[]
}

/** A local account as the admin sees it. */
export interface UserInfo {
  id: string
  username: string
  name?: string
  role: 'admin' | 'user'
  disabled?: boolean
  /** No password yet (a link to set one is out). */
  pending?: boolean
  mustChangePassword?: boolean
  /** Inside the delay after failed logins. */
  locked?: boolean
  /** Has a second factor. */
  totp?: boolean
  created: string
  lastLogin?: string
  you?: boolean
}

export type UserAction = 'reset' | 'reset-totp' | 'disable' | 'enable' | 'role' | 'delete'

export interface FetchRequest {
  /** Empty: use the token the server holds. */
  token?: string
  keep: boolean
  skip?: string[]
  contractNumber?: string
}

/**
 * What the page knows about the server: `none` (no server, the feature is
 * hidden), `no-session` (served by it, but this tab has no session key),
 * `unreachable` (it stopped), `ready`.
 */
export type Backend =
  { kind: 'none' } | { kind: 'checking' } | { kind: 'no-session' } | { kind: 'unreachable' } | { kind: 'ready'; status: BackendStatus }

export class BackendError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

type Doc = Pick<Document, 'querySelector'>

const page = (): Doc | undefined => (typeof document === 'undefined' ? undefined : document)

/** Storage that may be missing or throw (private windows, blocked site data). */
type Store = Pick<Storage, 'getItem' | 'setItem'>

function store(): Store | undefined {
  try {
    return window.sessionStorage
  } catch {
    return undefined
  }
}

/**
 * Moves the session key from the address (`#session=…`, where /login puts
 * it) into sessionStorage and takes it out of the address and the history
 * entry. Runs before anything reads the hash.
 */
export function takeSessionKey(
  loc: Pick<Location, 'hash' | 'pathname' | 'search'>,
  history: Pick<History, 'replaceState'>,
  storage = store(),
) {
  const params = new URLSearchParams(loc.hash.slice(1))
  const key = params.get('session')
  if (key === null) return
  params.delete('session')
  try {
    if (key) storage?.setItem(STORAGE_KEY, key)
  } catch {
    // Without storage the key is lost on reload; the printed link logs in again.
  }
  const rest = params.toString()
  history.replaceState(null, '', rest ? `#${rest}` : loc.pathname + loc.search)
}

/** The session key: the page's (hosted mode), else this tab's (local mode). */
export function sessionKey(storage = store(), doc = page()): string | undefined {
  const fromPage = doc?.querySelector(`meta[name="${SESSION_META}"]`)?.getAttribute('content')
  if (fromPage) return fromPage
  try {
    return storage?.getItem(STORAGE_KEY) ?? undefined
  } catch {
    return undefined
  }
}

/** A setup link (`#setup=…`, from the server's log) or a link to set a password (`#link=…`, from an admin). */
export function accountLink(hash: string): { kind: 'setup' | 'link'; code: string } | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  for (const kind of ['setup', 'link'] as const) {
    const code = params.get(kind)
    if (code) return { kind, code }
  }
  return undefined
}

/** Whether this page was served by ionos-explorer (a static host serves no such tag). */
export function servedByBackend(doc: Doc = document) {
  return doc.querySelector(`meta[name="${META}"]`) !== null
}

/** Whether ionos-explorer runs hosted for a team (rather than on this machine). */
export function hostedBackend(doc: Doc = document) {
  return doc.querySelector(`meta[name="${META}"]`)?.getAttribute('content') === 'hosted'
}

type FetchFn = typeof fetch

/** Talks to the local server. Every call sends the session key; the cookie goes along by itself. */
export class Client {
  private readonly fetchFn: FetchFn
  private readonly key: () => string | undefined
  constructor(fetchFn: FetchFn = (...a) => fetch(...a), key: () => string | undefined = sessionKey) {
    this.fetchFn = fetchFn
    this.key = key
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    // Before a session (logging in) the header only proves a script sent it.
    const headers: Record<string, string> = { [HEADER]: this.key() ?? 'login' }
    if (method === 'POST') headers['Content-Type'] = 'application/json'
    const res = await this.fetchFn(path, {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    })
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try {
        const e = (await res.json()) as { error?: string }
        if (e.error) msg = e.error
      } catch {
        // not JSON
      }
      throw new BackendError(res.status, msg)
    }
    return res
  }

  /** What the server says about itself, as a Backend. */
  async detect(): Promise<Backend> {
    // Without a key the answer is known (and a 401 would only clutter the console).
    if (!this.key()) return { kind: 'no-session' }
    let res: Response
    try {
      res = await this.fetchFn('api/status', {
        headers: { [HEADER]: this.key()! },
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
      })
    } catch {
      return { kind: 'unreachable' }
    }
    let body: unknown
    try {
      body = await res.json()
    } catch {
      return { kind: 'unreachable' } // not the server (a proxy's error page)
    }
    if ((body as { app?: string } | null)?.app !== 'ionos-explorer') return { kind: 'unreachable' }
    if (res.status === 401) return { kind: 'no-session' }
    if (!res.ok) return { kind: 'unreachable' }
    return { kind: 'ready', status: body as BackendStatus }
  }

  async start(req: FetchRequest): Promise<BackendStatus> {
    return (await this.call('POST', 'api/fetch', req)).json()
  }

  async cancel(): Promise<BackendStatus> {
    return (await this.call('POST', 'api/fetch/cancel')).json()
  }

  async forget(): Promise<BackendStatus> {
    return (await this.call('POST', 'api/forget')).json()
  }

  /** Hosted mode, no session needed: how to log in. */
  async loginMethods(): Promise<LoginMethods> {
    return (await this.call('GET', 'api/login-methods')).json()
  }

  /**
   * Hosted mode: logs in with a local account (sets the session cookie;
   * reload the page for the key). An account with a second factor answers
   * a ticket for `loginCode` instead.
   */
  async login(username: string, password: string): Promise<{ mustChangePassword?: boolean; secondFactor?: boolean; ticket?: string }> {
    return (await this.call('POST', 'api/login', { username, password })).json()
  }

  /** The second step of a login: a code of the authenticator app, or a recovery code. */
  async loginCode(ticket: string, code: string): Promise<void> {
    await this.call('POST', 'api/login/code', { ticket, code })
  }

  /** Starts setting up a second factor: the key for the app, and the otpauth:// address for its QR code. */
  async totpBegin(): Promise<{ key: string; uri: string }> {
    return (await this.call('POST', 'api/totp/begin')).json()
  }

  /** Turns the second factor on (the other sessions end); answers the recovery codes, shown once. */
  async totpEnable(password: string, code: string): Promise<{ recoveryCodes: string[]; status: BackendStatus }> {
    return (await this.call('POST', 'api/totp/enable', { password, code })).json()
  }

  async totpDisable(password: string): Promise<BackendStatus> {
    return (await this.call('POST', 'api/totp/disable', { password })).json()
  }

  async totpRecovery(password: string): Promise<string[]> {
    return ((await (await this.call('POST', 'api/totp/recovery', { password })).json()) as { recoveryCodes: string[] }).recoveryCodes
  }

  /** Creates the first admin with the code of the setup link, and logs in. */
  async setup(code: string, username: string, name: string, password: string): Promise<void> {
    await this.call('POST', 'api/setup', { code, username, name, password })
  }

  /** Whom a link to set a password is for. */
  async linkInfo(code: string): Promise<{ username: string; name?: string }> {
    return (await this.call('POST', 'api/link', { code })).json()
  }

  /** Sets the password with a link, and logs in. */
  async useLink(code: string, password: string): Promise<void> {
    await this.call('POST', 'api/link/password', { code, password })
  }

  /** Changes the own password; the other sessions end. */
  async changePassword(current: string, password: string): Promise<BackendStatus> {
    return (await this.call('POST', 'api/password', { current, password })).json()
  }

  async logoutOthers(): Promise<BackendStatus> {
    return (await this.call('POST', 'api/logout-others')).json()
  }

  /** Admins: the local accounts. */
  async users(): Promise<UserInfo[]> {
    return ((await (await this.call('GET', 'api/users')).json()) as { users: UserInfo[] }).users
  }

  /** Admins: adds an account; answers the link that sets its password. */
  async addUser(username: string, name: string, role: UserInfo['role']): Promise<{ id: string; link: string }> {
    return (await this.call('POST', 'api/users/add', { username, name, role })).json()
  }

  /** Admins: changes an account; `reset` answers a new link. */
  async changeUser(action: UserAction, id: string, role?: UserInfo['role']): Promise<{ link?: string }> {
    return (await this.call('POST', `api/users/${action}`, role ? { id, role } : { id })).json()
  }

  /** Hosted mode: ends the session; answers where the browser goes next. */
  async logout(): Promise<string> {
    const { next } = (await (await this.call('POST', 'api/logout')).json()) as { next: string }
    return next
  }

  /** The own history, newest first: of one contract, or of all. */
  async history(contract?: string): Promise<HistoryList> {
    return (await this.call('GET', contract ? `api/history?contract=${encodeURIComponent(contract)}` : 'api/history')).json()
  }

  /** A snapshot of the own history, decrypted by the server. */
  async historySnapshot(id: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.call('GET', `api/history/${encodeURIComponent(id)}`)).arrayBuffer())
  }

  async deleteHistory(id: string): Promise<void> {
    await this.call('POST', 'api/history/delete', { id })
  }

  /** The fetched snapshot; the server drops its copy. */
  async takeResult(): Promise<Uint8Array> {
    return new Uint8Array(await (await this.call('POST', 'api/fetch/result')).arrayBuffer())
  }
}

/** The skip field: comma- or space-separated patterns. */
export function parseSkip(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** "57 of 230 requests · 2 could not be read" */
export function progressText(f: FetchStatus): string {
  const parts = [`${f.done} of ${f.total} request${f.total === 1 ? '' : 's'}`]
  if (f.problems) parts.push(`${f.problems} could not be read`)
  return parts.join(' · ')
}
