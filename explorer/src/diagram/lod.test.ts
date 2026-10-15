import { describe, expect, it } from 'vitest'
import { LOD_FAR, LOD_MID, lodFor, type Lod } from './lod'

/** The levels a zoom gesture passes through, each step starting from the last level. */
const walk = (zooms: number[], start?: Lod) => {
  const out: Lod[] = []
  let level = start
  for (const z of zooms) out.push((level = lodFor(z, level)))
  return out
}

describe('lodFor', () => {
  it('maps the zoom to three levels', () => {
    expect([1, 0.6, 0.59, 0.3, 0.29, 0.04].map((z) => lodFor(z))).toEqual(['near', 'near', 'mid', 'mid', 'far', 'far'])
  })

  it('holds the current level a little past each threshold', () => {
    expect(lodFor(0.57, 'near')).toBe('near')
    expect(lodFor(0.62, 'mid')).toBe('mid')
    expect(lodFor(0.29, 'mid')).toBe('mid')
    expect(lodFor(0.31, 'far')).toBe('far')
  })

  it('changes once the zoom is clearly past it', () => {
    expect(lodFor(LOD_MID / 1.1 - 0.01, 'near')).toBe('mid')
    expect(lodFor(LOD_MID * 1.1, 'mid')).toBe('near')
    expect(lodFor(LOD_FAR / 1.1 - 0.01, 'mid')).toBe('far')
    expect(lodFor(LOD_FAR * 1.1, 'far')).toBe('mid')
  })

  it('jumps over a level when the zoom does', () => {
    expect(lodFor(0.1, 'near')).toBe('far')
    expect(lodFor(1, 'far')).toBe('near')
  })

  it('does not flicker while the zoom wobbles around a threshold', () => {
    expect(walk([0.62, 0.59, 0.61, 0.58, 0.6, 0.56], 'near')).toEqual(['near', 'near', 'near', 'near', 'near', 'near'])
    expect(walk([0.59, 0.61, 0.58, 0.63, 0.6], 'mid')).toEqual(['mid', 'mid', 'mid', 'mid', 'mid'])
    expect(walk([0.31, 0.29, 0.3, 0.28, 0.32], 'mid')).toEqual(['mid', 'mid', 'mid', 'mid', 'mid'])
  })

  it('goes down and back up through all levels', () => {
    expect(walk([1, 0.7, 0.5, 0.4, 0.25, 0.1, 0.25, 0.35, 0.5, 0.7, 1])).toEqual([
      'near',
      'near',
      'mid',
      'mid',
      'far',
      'far',
      'far',
      'mid',
      'mid',
      'near',
      'near',
    ])
  })
})
