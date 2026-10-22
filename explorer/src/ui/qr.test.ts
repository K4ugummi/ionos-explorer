import { describe, expect, it } from 'vitest'
import { qrModules, qrPath } from './qr'

const uri =
  'otpauth://totp/IONOS%20Explorer:alice?algorithm=SHA1&digits=6&issuer=IONOS+Explorer&period=30&secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' // gitleaks:allow (made up: "1234567890…" in base32)

/** A finder pattern (7×7: dark ring, light ring, dark 3×3 core) at row r, column c. */
function finder(m: boolean[][], r: number, c: number) {
  for (let y = 0; y < 7; y++)
    for (let x = 0; x < 7; x++) {
      const ring = Math.max(Math.abs(y - 3), Math.abs(x - 3))
      if (m[r + y][c + x] !== (ring !== 2)) return false
    }
  return true
}

describe('QR code', () => {
  it('has a version’s size and the three finder patterns', () => {
    const m = qrModules(uri)
    const n = m.length
    expect((n - 17) % 4).toBe(0)
    expect(n).toBeGreaterThanOrEqual(33) // 120-odd bytes need version 6 or more at level M
    expect(m.every((row) => row.length === n)).toBe(true)
    expect(finder(m, 0, 0) && finder(m, 0, n - 7) && finder(m, n - 7, 0)).toBe(true)
    expect(finder(m, n - 7, n - 7)).toBe(false)
  })

  it('is the same for the same text', () => {
    expect(qrModules(uri)).toEqual(qrModules(uri))
  })

  it('draws each dark run once, behind the quiet zone', () => {
    const m = [
      [true, true, false, true],
      [false, false, false, false],
    ]
    expect(qrPath(m)).toBe('M4 4h2v1h-2zM7 4h1v1h-1z')
    expect(qrPath(m, 0)).toBe('M0 0h2v1h-2zM3 0h1v1h-1z')
  })
})
