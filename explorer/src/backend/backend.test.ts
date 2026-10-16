import { describe, expect, it, vi } from 'vitest'
import { BackendError, Client, HEADER, STORAGE_KEY, parseSkip, progressText, servedByBackend, sessionKey, takeSessionKey } from './backend'

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
})

describe('backend detection', () => {
  it('only with the marker ionos-explorer puts into its index.html', () => {
    expect(servedByBackend({ querySelector: (s: string) => (s === 'meta[name="ionos-explorer"]' ? ({} as Element) : null) })).toBe(true)
    expect(servedByBackend({ querySelector: () => null })).toBe(false)
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
    expect(calls.map(([u]) => u)).toEqual(['/api/fetch', '/api/fetch/cancel', '/api/forget'])
    const [, init] = calls[0]
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ [HEADER]: 'k', 'Content-Type': 'application/json' })
    expect(JSON.parse(init.body as string)).toEqual({ token: 't0ken', keep: true, skip: ['/um'], contractNumber: '42' })
    expect(calls[1][1].body).toBe('{}')
    // Relative URLs: the page talks only to the server it came from.
    expect(calls.every(([u]) => u.startsWith('/api/'))).toBe(true)
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
