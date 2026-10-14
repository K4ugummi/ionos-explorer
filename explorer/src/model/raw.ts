// Defensive accessors for raw API JSON. Snapshots come from many API versions
// and accounts, so nothing is assumed to exist or to have the expected type.

export type Obj = Record<string, unknown>

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
export const obj = (v: unknown): Obj => (isObj(v) ? v : {})
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

export const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined

export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

export const strs = (v: unknown): string[] => arr(v).flatMap((x) => str(x) ?? [])

/** Items of a collection document (`{items: [...]}`). */
export const items = (doc: unknown): Obj[] => arr(obj(doc).items).filter(isObj)

export const props = (o: Obj): Obj => obj(o.properties)

/** Items of an embedded collection, e.g. `entities.nics.items`. */
export const entityItems = (o: Obj, key: string): Obj[] => items(obj(o.entities)[key])
