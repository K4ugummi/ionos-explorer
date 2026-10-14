import { useCallback, useEffect, useState } from 'react'

const read = () => new URLSearchParams(window.location.hash.slice(1))

/**
 * Selection and query live in the URL hash so links are shareable (within
 * the same snapshot) and the browser's back button works.
 */
export function useHashState() {
  const [params, setParams] = useState(read)

  useEffect(() => {
    const sync = () => setParams(read())
    window.addEventListener('hashchange', sync)
    window.addEventListener('popstate', sync)
    return () => {
      window.removeEventListener('hashchange', sync)
      window.removeEventListener('popstate', sync)
    }
  }, [])

  const update = useCallback((patch: Record<string, string | undefined>, push: boolean) => {
    const p = read()
    for (const [k, v] of Object.entries(patch)) {
      if (v) p.set(k, v)
      else p.delete(k)
    }
    const hash = p.toString()
    if (hash === read().toString()) return
    const url = hash ? `#${hash}` : window.location.pathname + window.location.search
    if (push) window.history.pushState(null, '', url)
    else window.history.replaceState(null, '', url)
    setParams(new URLSearchParams(hash))
  }, [])

  return [params, update] as const
}
