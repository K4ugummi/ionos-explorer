/**
 * Level of detail from the zoom: `near` shows everything, `mid` titles,
 * tags and pills, `far` titles only. Applied as a class on the canvas, so
 * zooming restyles the boxes but never lays them out again.
 */
export type Lod = 'near' | 'mid' | 'far'

/** Below this zoom the view is `mid`, below the second `far`. */
export const LOD_MID = 0.6
export const LOD_FAR = 0.3

/**
 * How far past a threshold the zoom has to go before the level changes back,
 * as a factor: a view resting near a threshold (a fitted view often does)
 * must not flicker between two levels while the user nudges the zoom.
 */
const SLACK = 1.1

export function lodFor(zoom: number, previous?: Lod): Lod {
  // The current level holds a little beyond its thresholds.
  const [near, far] =
    previous === 'near'
      ? [LOD_MID / SLACK, LOD_FAR]
      : previous === 'mid'
        ? [LOD_MID * SLACK, LOD_FAR / SLACK]
        : previous === 'far'
          ? [LOD_MID, LOD_FAR * SLACK]
          : [LOD_MID, LOD_FAR]
  return zoom >= near ? 'near' : zoom >= far ? 'mid' : 'far'
}
