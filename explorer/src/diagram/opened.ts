import type { Diagram } from './types'

/**
 * Groups and routers the user opened, per view (`dc:<id>`, `focus:…`, …):
 * kept in this browser per contract, so a reload or another tab shows them
 * the same way. Keys are what `DiagramActions.setOpen` gets: a group's id,
 * or `lans:<router box>` for a router's folded LANs.
 */
export type Opened = ReadonlyMap<string, ReadonlySet<string>>

export const NOTHING_OPENED: Opened = new Map()

/** Views remembered at most; the ones opened longest ago are forgotten first. */
export const MAX_VIEWS = 100

const key = (scope: string) => `ionos-explorer:opened:${scope}`

export function parseOpened(raw: string | null): Opened {
  if (!raw) return NOTHING_OPENED
  try {
    const v = JSON.parse(raw) as unknown
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return NOTHING_OPENED
    const out = new Map<string, ReadonlySet<string>>()
    for (const [view, keys] of Object.entries(v)) {
      const list = Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : []
      if (list.length) out.set(view, new Set(list))
    }
    return out
  } catch {
    return NOTHING_OPENED
  }
}

/** Views with nothing open are left out; beyond `MAX_VIEWS` the oldest go (a Map keeps the order they were last set in). */
export function serializeOpened(o: Opened): string {
  const views = [...o].filter(([, keys]) => keys.size > 0).slice(-MAX_VIEWS)
  return JSON.stringify(Object.fromEntries(views.map(([view, keys]) => [view, [...keys].sort()])))
}

export function loadOpened(scope: string): Opened {
  try {
    return parseOpened(localStorage.getItem(key(scope)))
  } catch {
    return NOTHING_OPENED
  }
}

export function saveOpened(o: Opened, scope: string) {
  try {
    const raw = serializeOpened(o)
    if (raw === '{}') localStorage.removeItem(key(scope))
    else localStorage.setItem(key(scope), raw)
  } catch {
    // Private mode or storage disabled: the groups stay open as long as the page.
  }
}

/** The view's opened set changed; the view moves to the end (most recent). */
export function withView(o: Opened, view: string, keys: ReadonlySet<string>): Opened {
  const next = new Map(o)
  next.delete(view)
  if (keys.size) next.set(view, keys)
  return next
}

/**
 * What "Expand all" opens and "Collapse all" closes in a diagram: the
 * groups drawn collapsed (their "+N more" box), the routers with folded
 * LANs, and the ones open now.
 */
export function expandable(d: Diagram): { closed: string[]; open: string[] } {
  const closed = new Set<string>()
  const open = new Set<string>()
  for (const n of d.nodes) {
    if (n.type === 'more' && n.parent) closed.add(n.parent)
    if (n.data.collapsible) open.add(n.id)
    const only = n.data.only
    if (only) (only.open ? open : closed).add(only.key)
  }
  return { closed: [...closed], open: [...open] }
}
