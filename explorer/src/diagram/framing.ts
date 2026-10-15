import type { Point } from './types'

export type Box = Point & { width: number; height: number }

/**
 * How the canvas last placed the view on its own: the whole diagram fitted,
 * or centred on the selection. Undefined once the user pans or zooms.
 */
export type Framing = { kind: 'fit' } | { kind: 'center'; target: Box; zoom: number }

export interface Size {
  width: number
  height: number
}

/**
 * Whether a resized canvas should be framed again. Only while the view is
 * still where the canvas put it; a view the user moved is kept. Sub-pixel
 * changes and a hidden (zero-sized) canvas do not count.
 */
export function refitOnResize(framing: Framing | undefined, before: Size, after: Size): boolean {
  if (!framing || after.width < 1 || after.height < 1) return false
  return Math.abs(after.width - before.width) >= 1 || Math.abs(after.height - before.height) >= 1
}

/** Whether a legend of its natural width fits into the room left for it (widths are fractional). */
export const legendFits = (natural: number, room: number) => natural <= room + 0.5
