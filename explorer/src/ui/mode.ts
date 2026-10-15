import { DEFAULT_HOPS, MAX_HOPS, networkNode } from '../model/paths'
import type { Model } from '../model/types'

/**
 * A diagram mode on top of the contract or datacenter view: what one
 * resource is connected to (`focus=<id>`), or how one reaches another
 * (`path=<from>,<to>`), with `hops` (1–3) for how far a focus looks. The
 * `dc` in the hash stays: it is the view to go back to.
 */
export type DiagramMode = { kind: 'focus'; id: string; hops: number } | { kind: 'path'; from: string; to: string; hops: number }

/** The hash entries of a mode, as read. */
export interface ModeParams {
  focus?: string | null
  path?: string | null
  hops?: string | null
}

/** The mode in the hash, if it names resources of the network (see `networkNode`). */
export function parseMode(params: ModeParams, model: Model): DiagramMode | undefined {
  const n = Math.round(Number(params.hops))
  const hops = n >= 1 && n <= MAX_HOPS ? n : DEFAULT_HOPS
  const [from, to, ...rest] = (params.path ?? '').split(',')
  const [a, b] = [from && networkNode(model, from), to && networkNode(model, to)]
  if (a && b && a !== b && !rest.length) return { kind: 'path', from, to, hops }
  const focus = params.focus
  if (focus && networkNode(model, focus)) return { kind: 'focus', id: focus, hops }
  return undefined
}

/** Hash entries for a mode; undefined ones are removed (no mode: back to the plain view). */
export function modeParams(mode?: DiagramMode): Record<string, string | undefined> {
  return {
    focus: mode?.kind === 'focus' ? mode.id : undefined,
    path: mode?.kind === 'path' ? `${mode.from},${mode.to}` : undefined,
    hops: mode && mode.hops !== DEFAULT_HOPS ? String(mode.hops) : undefined,
  }
}

/** Layouts and opened groups are kept per view; this names a mode's view. */
export function modeKey(mode: DiagramMode) {
  return mode.kind === 'focus' ? `focus:${mode.id}:${mode.hops}` : `path:${mode.from},${mode.to}:${mode.hops}`
}
