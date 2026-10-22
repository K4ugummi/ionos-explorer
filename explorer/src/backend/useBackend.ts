import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Client, hostedBackend, servedByBackend, type Backend, type BackendStatus, type FetchRequest } from './backend'

/** Where a fetched snapshot went besides the page: its ID in the history, or why it is not there. */
export interface FetchedInfo {
  historyId?: string
  historyError?: string
}

/** How often the page asks for progress while a fetch runs (an EventSource cannot send the session header). */
export const POLL_MS = 400

export interface BackendApi {
  backend: Backend
  /** ionos-explorer runs hosted for a team, with logins (not on this machine). */
  hosted: boolean
  /** A request is on its way, or the fetched snapshot is being opened. */
  busy: boolean
  /** The last action's, fetch's or opening's error, in words. */
  error?: string
  /** How the last fetch this page followed ended, if not with a snapshot. */
  notice?: string
  start: (req: FetchRequest) => Promise<void>
  cancel: () => Promise<void>
  forget: () => Promise<void>
  /** Opens a fetched snapshot this page did not see being fetched (it was reloaded meanwhile, say). */
  takeWaiting: () => Promise<void>
  /** Hosted mode: ends the session and leaves the page. */
  logout: () => Promise<void>
  /** For the account forms: the client, and a status one of its calls answered. */
  client: Client
  apply: (status: BackendStatus) => void
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The local ionos-explorer server, if the page was served by it: its state,
 * polled while a fetch runs, and the actions. A finished fetch this page saw
 * running is taken (the server drops it) and handed to `onResult`.
 */
export function useBackend(
  onResult: (data: Uint8Array, info: FetchedInfo) => Promise<void>,
  client = defaultClient,
  leave: (url: string) => void = (url) => window.location.assign(url),
): BackendApi {
  const [backend, setBackend] = useState<Backend>(() => (servedByBackend() ? { kind: 'checking' } : { kind: 'none' }))
  const [hosted] = useState(() => hostedBackend())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const resultHandler = useRef(onResult)
  useEffect(() => {
    resultHandler.current = onResult
  }, [onResult])

  const take = useCallback(async () => {
    setBusy(true)
    setError(undefined)
    try {
      const b = await client.detect()
      const f = b.kind === 'ready' ? b.status.fetch : undefined
      await resultHandler.current(await client.takeResult(), { historyId: f?.historyId, historyError: f?.historyError })
    } catch (e) {
      setError(`Could not open the fetched snapshot: ${message(e)}`)
    } finally {
      setBusy(false)
      setBackend(await client.detect())
    }
  }, [client])

  // One loop at a time follows a running fetch until it ends, then opens its result.
  const polling = useRef(false)
  const follow = useCallback(async () => {
    if (polling.current) return
    polling.current = true
    try {
      for (;;) {
        const b = await client.detect()
        setBackend(b)
        const f = b.kind === 'ready' ? b.status.fetch : undefined
        if (f?.state === 'running') {
          await sleep(POLL_MS)
          continue
        }
        // Outcomes are reported only for fetches this page followed, not for older ones.
        if (f?.state === 'done' && f.resultReady) await take()
        else if (f?.state === 'failed') setError(f.error ?? 'The fetch failed.')
        else if (f?.state === 'cancelled') setNotice('Cancelled.')
        return
      }
    } finally {
      polling.current = false
    }
  }, [client, take])

  const enabled = backend.kind !== 'none'
  useEffect(() => {
    if (!enabled) return
    // A fetch already running (the page was reloaded) is followed too.
    void client.detect().then((b) => {
      setBackend(b)
      if (b.kind === 'ready' && b.status.fetch?.state === 'running') void follow()
    })
  }, [enabled, client, follow])

  // Show when the server forgets an unused token.
  const forgetAt = backend.kind === 'ready' ? backend.status.tokenForgetAt : undefined
  useEffect(() => {
    if (!forgetAt) return
    const ms = new Date(forgetAt).getTime() - Date.now() + 1000
    const t = setTimeout(() => void client.detect().then(setBackend), Math.min(Math.max(ms, 1000), 2 ** 31 - 1))
    return () => clearTimeout(t)
  }, [forgetAt, client])

  const act = useCallback(
    async (fn: () => Promise<BackendStatus>, then?: () => void) => {
      setBusy(true)
      setError(undefined)
      setNotice(undefined)
      try {
        setBackend({ kind: 'ready', status: await fn() })
        then?.()
      } catch (e) {
        setError(message(e))
        setBackend(await client.detect())
      } finally {
        setBusy(false)
      }
    },
    [client],
  )

  const start = useCallback(
    (req: FetchRequest) =>
      act(
        () => client.start(req),
        () => void follow(),
      ),
    [act, client, follow],
  )
  const cancel = useCallback(() => act(() => client.cancel()), [act, client])
  const forget = useCallback(() => act(() => client.forget()), [act, client])
  const logout = useCallback(async () => {
    setBusy(true)
    setError(undefined)
    try {
      leave(await client.logout())
    } catch (e) {
      setError(message(e))
      setBusy(false)
    }
  }, [client, leave])

  const apply = useCallback((status: BackendStatus) => setBackend({ kind: 'ready', status }), [])

  return useMemo(
    () => ({ backend, hosted, busy, error, notice, start, cancel, forget, takeWaiting: take, logout, client, apply }),
    [backend, hosted, busy, error, notice, start, cancel, forget, take, logout, client, apply],
  )
}

const defaultClient = new Client()
