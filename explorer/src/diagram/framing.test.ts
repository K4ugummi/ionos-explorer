import { describe, expect, it } from 'vitest'
import { legendFits, refitOnResize, type Framing } from './framing'

describe('refitOnResize', () => {
  const fit: Framing = { kind: 'fit' }
  const center: Framing = { kind: 'center', target: { x: 10, y: 20, width: 236, height: 54 }, zoom: 1 }
  const wide = { width: 1200, height: 800 }

  it('frames again while the view is where the canvas put it', () => {
    expect(refitOnResize(fit, wide, { width: 600, height: 800 })).toBe(true)
    expect(refitOnResize(center, wide, { width: 1200, height: 500 })).toBe(true)
  })

  it('keeps a view the user moved', () => {
    expect(refitOnResize(undefined, wide, { width: 600, height: 800 })).toBe(false)
  })

  it('ignores sub-pixel changes and a hidden canvas', () => {
    expect(refitOnResize(fit, wide, wide)).toBe(false)
    expect(refitOnResize(fit, wide, { width: 1200.4, height: 799.7 })).toBe(false)
    expect(refitOnResize(fit, wide, { width: 0, height: 0 })).toBe(false)
  })
})

describe('legendFits', () => {
  it('compares the one-line width with the room', () => {
    expect(legendFits(500, 500)).toBe(true)
    expect(legendFits(500.3, 500)).toBe(true)
    expect(legendFits(501, 500)).toBe(false)
  })
})
