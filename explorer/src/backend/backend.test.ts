import { describe, expect, it, vi } from 'vitest'
import {
  accountLink,
  BackendError,
  Client,
  HEADER,
  STORAGE_KEY,
  hostedBackend,
  parseSkip,
  progressText,
  servedByBackend,
  sessionKey,
  takeSessionKey,
} from './backend'

function memoryStore(throws = false) {
  const m = new Map<string, string>()
  return {
    m,
    getItem: (k: string) => {
      if (throws) throw new Error('blocked')
      return m.get(k) ?? null
    },
    setItem: (k: string, v: string) => {
      if (throws) throw new Error('blocked')
      m.set(k, v)
    },
  }
}

const loc = (hash: string) => ({ hash, pathname: '/', search: '' })

describe('session key', () => {
  it('moves the key from the address into session storage', () => {
    const store = memoryStore()
    const history = { replaceState: vi.fn() }
    takeSessionKey(loc('#session=k3y_-'), history, store)
    expect(store.m.get(STORAGE_KEY)).toBe('k3y_-')
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/')
    expect(sessionKey(store)).toBe('k3y_-')
  })

  it('keeps the rest of the hash state', () => {
    const history = { replaceState: vi.fn() }
    takeSessionKey(loc('#view=overview&session=abc&q=x'), history, memoryStore())
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '#view=overview&q=x')
  })

  it('leaves an address without a key alone', () => {
    const store = memoryStore()
    const history = { replaceState: vi.fn() }
    takeSessionKey(loc('#view=overview'), history, store)
    takeSessionKey(loc(''), history, store)
    expect(history.replaceState).not.toHaveBeenCalled()
    expect(store.m.size).toBe(0)
  })

  it('still removes the key from the address when storage is blocked', () => {
    const history = { replaceState: vi.fn() }
    takeSessionKey(loc('#session=abc'), history, memoryStore(true))
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/')
    expect(sessionKey(memoryStore(true))).toBeUndefined()
    expect(sessionKey(undefined)).toBeUndefined()
  })

  it('prefers the key the page came with (hosted mode)', () => {
    const store = memoryStore()
    store.setItem(STORAGE_KEY, 'old-tab-key')
    const withKey = { querySelector: (s: string) => (s === 'meta[name="ionos-explorer-session"]' ? meta('page-key') : null) }
    expect(sessionKey(store, withKey)).toBe('page-key')
    expect(sessionKey(undefined, withKey)).toBe('page-key')
    expect(sessionKey(store, { querySelector: () => null })).toBe('old-tab-key')
  })
})

// A meta tag as far as the code reads it (no DOM in these tests).
const meta = (content: string) => ({ getAttribute: (name: string) => (name === 'content' ? content : null) }) as unknown as Element

describe('backend detection', () => {
  it('only with the marker ionos-explorer puts into its index.html', () => {
    const marked = (content: string) => ({ querySelector: (s: string) => (s === 'meta[name="ionos-explorer"]' ? meta(content) : null) })
    expect(servedByBackend(marked('local-server'))).toBe(true)
    expect(servedByBackend({ querySelector: () => null })).toBe(false)
    expect(hostedBackend(marked('local-server'))).toBe(false)
    expect(hostedBackend(marked('hosted'))).toBe(true)
    expect(hostedBackend({ querySelector: () => null })).toBe(false)
  })

  const json = (status: number, body: unknown, type = 'application/json') =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': type } })
  const status = { app: 'ionos-explorer', version: 'test', tokenHeld: false }

  it.each([
    ['the server', () => json(200, status), 'ready'],
    ['the server, this tab without a session', () => json(401, { app: 'ionos-explorer', error: 'no session' }), 'no-session'],
    ['a static host with SPA fallback', () => json(200, '<!doctype html><html></html>', 'text/html'), 'unreachable'],
    ['a static host without', () => json(404, 'Not found', 'text/plain'), 'unreachable'],
    ['some other JSON API', () => json(200, { app: 'other' }), 'unreachable'],
    ['a proxy error', () => json(502, 'Bad gateway', 'text/plain'), 'unreachable'],
    [
      'no server',
      () => {
        throw new TypeError('Failed to fetch')
      },
      'unreachable',
    ],
  ])('%s', async (_, respond, kind) => {
    const client = new Client(
      async () => respond(),
      () => 'key',
    )
    const b = await client.detect()
    expect(b.kind).toBe(kind)
    if (b.kind === 'ready') expect(b.status).toEqual(status)
  })

  it('sends the session key, and asks nothing without one', async () => {
    const seen: RequestInit[] = []
    const fetchFn = async (_: RequestInfo | URL, init?: RequestInit) => (seen.push(init!), json(200, status))
    expect((await new Client(fetchFn, () => 'the-key').detect()).kind).toBe('ready')
    expect((await new Client(fetchFn, () => undefined).detect()).kind).toBe('no-session')
    expect(seen).toHaveLength(1)
    expect(seen[0].headers).toEqual({ [HEADER]: 'the-key' })
    expect(seen[0]).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
  })
})

describe('client', () => {
  it('posts JSON with the session header, same origin only', async () => {
    const calls: [string, RequestInit][] = []
    const client = new Client(
      async (url, init) => (calls.push([String(url), init!]), new Response(JSON.stringify({ app: 'ionos-explorer' }), { status: 202 })),
      () => 'k',
    )
    await client.start({ token: 't0ken', keep: true, skip: ['/um'], contractNumber: '42' })
    await client.cancel()
    await client.forget()
    expect(calls.map(([u]) => u)).toEqual(['api/fetch', 'api/fetch/cancel', 'api/forget'])
    const [, init] = calls[0]
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ [HEADER]: 'k', 'Content-Type': 'application/json' })
    expect(JSON.parse(init.body as string)).toEqual({ token: 't0ken', keep: true, skip: ['/um'], contractNumber: '42' })
    expect(calls[1][1].body).toBe('{}')
    // Relative URLs: the page talks only to the server it came from, below whatever path it lives.
    expect(calls.every(([u]) => u.startsWith('api/'))).toBe(true)
  })

  it('logs out and says where to go', async () => {
    const calls: string[] = []
    const client = new Client(
      async (url) => (calls.push(String(url)), new Response(JSON.stringify({ app: 'ionos-explorer', next: '/tools/x/login' }))),
      () => 'k',
    )
    expect(await client.logout()).toBe('/tools/x/login')
    expect(calls).toEqual(['api/logout'])
  })

  it('reports the server’s error message', async () => {
    const client = new Client(
      async () => new Response(JSON.stringify({ app: 'ionos-explorer', error: 'a fetch is already running' }), { status: 409 }),
    )
    const err = await client.start({ keep: true }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BackendError)
    expect((err as BackendError).status).toBe(409)
    expect((err as BackendError).message).toBe('a fetch is already running')
    const plain = new Client(async () => new Response('boom', { status: 500 }))
    await expect(plain.cancel()).rejects.toThrow('HTTP 500')
  })

  it('asks for the own history', async () => {
    const calls: [string, RequestInit | undefined][] = []
    const client = new Client(async (url, init) => {
      calls.push([String(url), init])
      return String(url).startsWith('api/history/x')
        ? new Response(new Uint8Array([1, 2]))
        : new Response(JSON.stringify({ app: 'ionos-explorer', entries: [], used: 0 }))
    }, () => 'k')
    expect((await client.history()).entries).toEqual([])
    await client.history('1234')
    expect(await client.historySnapshot('x/../y')).toEqual(new Uint8Array([1, 2]))
    await client.deleteHistory('1-20261015T081904Z-0a0b0c0d')
    expect(calls.map((c) => c[0])).toEqual(['api/history', 'api/history?contract=1234', 'api/history/x%2F..%2Fy', 'api/history/delete'])
    expect(calls[3][1]?.method).toBe('POST')
    expect(calls[3][1]?.body).toBe('{"id":"1-20261015T081904Z-0a0b0c0d"}')
    const headers = calls[0][1]?.headers as Record<string, string> | undefined
    expect(headers?.['X-Ionos-Explorer']).toBe('k')
  })

  it('logs in with a second factor and sets one up', async () => {
    const calls: [string, string | undefined][] = []
    const answers: Record<string, unknown> = {
      'api/login': { app: 'ionos-explorer', secondFactor: true, ticket: 't1' },
      'api/totp/begin': { app: 'ionos-explorer', key: 'ABCD', uri: 'otpauth://totp/x' },
      'api/totp/enable': { app: 'ionos-explorer', recoveryCodes: ['a-b'], status: { app: 'ionos-explorer', totp: true } },
      'api/totp/recovery': { app: 'ionos-explorer', recoveryCodes: ['c-d'] },
    }
    const client = new Client(async (url, init) => {
      calls.push([String(url), init?.body as string | undefined])
      return new Response(JSON.stringify(answers[String(url)] ?? { app: 'ionos-explorer' }))
    }, () => 'k')
    expect(await client.login('alice', 'pw')).toEqual({ app: 'ionos-explorer', secondFactor: true, ticket: 't1' })
    await client.loginCode('t1', '123 456')
    expect((await client.totpBegin()).key).toBe('ABCD')
    expect((await client.totpEnable('pw', '123456')).recoveryCodes).toEqual(['a-b'])
    expect(await client.totpRecovery('pw')).toEqual(['c-d'])
    await client.totpDisable('pw')
    expect(calls).toEqual([
      ['api/login', '{"username":"alice","password":"pw"}'],
      ['api/login/code', '{"ticket":"t1","code":"123 456"}'],
      ['api/totp/begin', '{}'],
      ['api/totp/enable', '{"password":"pw","code":"123456"}'],
      ['api/totp/recovery', '{"password":"pw"}'],
      ['api/totp/disable', '{"password":"pw"}'],
    ])
  })

  it('takes the fetched snapshot as bytes', async () => {
    const client = new Client(async () => new Response(new Uint8Array([80, 75, 3, 4]), { status: 200 }))
    expect(await client.takeResult()).toEqual(new Uint8Array([80, 75, 3, 4]))
  })
})

describe('fetch panel helpers', () => {
  it('parses the skip field', () => {
    expect(parseSkip(' /um, vpn\n/datacenters/{datacenterId}/volumes ,, ')).toEqual(['/um', 'vpn', '/datacenters/{datacenterId}/volumes'])
    expect(parseSkip('')).toEqual([])
  })

  it('words the progress', () => {
    const f = { state: 'running' as const, done: 57, total: 230, problems: 0, resultReady: false, startedAt: '' }
    expect(progressText(f)).toBe('57 of 230 requests')
    expect(progressText({ ...f, done: 1, total: 1, problems: 2 })).toBe('1 of 1 request · 2 could not be read')
  })
})

describe('account links', () => {
  it('finds a setup or password link in the address', () => {
    expect(accountLink('#setup=abc')).toEqual({ kind: 'setup', code: 'abc' })
    expect(accountLink('#view=overview&link=x_y-z')).toEqual({ kind: 'link', code: 'x_y-z' })
    expect(accountLink('#link=')).toBeUndefined()
    expect(accountLink('#view=overview')).toBeUndefined()
    expect(accountLink('')).toBeUndefined()
  })
})

describe('account calls', () => {
  it('log in before a session with the header, and call the admin routes', async () => {
    const calls: [string, RequestInit][] = []
    const client = new Client(
      async (url, init) => (calls.push([String(url), init!]), new Response(JSON.stringify({ app: 'ionos-explorer', users: [] }))),
      () => undefined,
    )
    await client.login('alice', 'pw')
    await client.users()
    await client.changeUser('role', 'u1', 'admin')
    await client.changeUser('delete', 'u1')
    expect(calls.map(([u, i]) => `${i.method} ${u}`)).toEqual([
      'POST api/login',
      'GET api/users',
      'POST api/users/role',
      'POST api/users/delete',
    ])
    expect(calls[0][1].headers).toEqual({ [HEADER]: 'login', 'Content-Type': 'application/json' })
    expect(JSON.parse(calls[2][1].body as string)).toEqual({ id: 'u1', role: 'admin' })
    expect(JSON.parse(calls[3][1].body as string)).toEqual({ id: 'u1' })
  })
})
