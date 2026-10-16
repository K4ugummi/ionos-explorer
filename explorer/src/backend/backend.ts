// The local server of ionos-explorer (exporter/internal/server), when the
// explorer is served by it: fetch the contract from the IONOS API there.
// Without it (static build, `npm run dev`) none of this is used and no
// request is made.

/** The header that carries the session key; see server.Header. */
export const HEADER = 'X-Ionos-Explorer'
/** Where the page keeps the session key: per tab and per origin (port included). */
export const STORAGE_KEY = 'ionos-explorer:session'
/** The server marks the index.html it serves with this meta tag. */
export const META = 'ionos-explorer'

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
}

export interface BackendStatus {
  app: 'ionos-explorer'
  version: string
  tokenHeld: boolean
  tokenForgetAt?: string
  fetch?: FetchStatus
}

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

export function sessionKey(storage = store()): string | undefined {
  try {
    return storage?.getItem(STORAGE_KEY) ?? undefined
  } catch {
    return undefined
  }
}

/** Whether this page was served by ionos-explorer (a static host serves no such tag). */
export function servedByBackend(doc: Pick<Document, 'querySelector'> = document) {
  return doc.querySelector(`meta[name="${META}"]`) !== null
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
    const headers: Record<string, string> = {}
    const key = this.key()
    if (key) headers[HEADER] = key
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
      res = await this.fetchFn('/api/status', {
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
    return (await this.call('POST', '/api/fetch', req)).json()
  }

  async cancel(): Promise<BackendStatus> {
    return (await this.call('POST', '/api/fetch/cancel')).json()
  }

  async forget(): Promise<BackendStatus> {
    return (await this.call('POST', '/api/forget')).json()
  }

  /** The fetched snapshot; the server drops its copy. */
  async takeResult(): Promise<Uint8Array> {
    return new Uint8Array(await (await this.call('POST', '/api/fetch/result')).arrayBuffer())
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
