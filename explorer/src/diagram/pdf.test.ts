import { unzlibSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { makePdf, MAX_PAGE_SIDE, pageSize, pdfString, rgbOf } from './pdf'

const text = (b: Uint8Array) => new TextDecoder('latin1').decode(b)

describe('PDF export', () => {
  it('sizes pages in points, at most Acrobat’s largest page', () => {
    expect(pageSize(800, 600)).toEqual({ pageWidth: 600, pageHeight: 450 })
    const big = pageSize(40_000, 10_000)
    expect(big.pageWidth).toBe(MAX_PAGE_SIDE)
    expect(big.pageHeight).toBe(MAX_PAGE_SIDE / 4)
  })

  it('puts transparent pixels on white paper', () => {
    expect([...rgbOf(new Uint8ClampedArray([10, 20, 30, 255, 0, 0, 0, 0, 255, 0, 0, 128]))]).toEqual([10, 20, 30, 255, 255, 255, 255, 127, 127])
  })

  it('escapes titles, and writes others than ASCII as UTF-16', () => {
    expect(pdfString('a (b) \\ c')).toBe('(a \\(b\\) \\\\ c)')
    expect(pdfString('Köln → B')).toBe('<FEFF004B00F6006C006E0020219200200042>')
  })

  it('writes one page per picture with a correct cross-reference table', () => {
    const opaque = (w: number, h: number) => new Uint8ClampedArray(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : 200))
    const px = (w: number, h: number) => ({ rgba: opaque(w, h), width: w, height: h, ...pageSize(w, h) })
    const pdf = makePdf([px(4, 2), px(3, 3)], 'All views')
    const s = text(pdf)
    expect(s.startsWith('%PDF-1.4\n')).toBe(true)
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true)
    expect(s).toContain('/Type /Pages /Count 2 /Kids [4 0 R 7 0 R]')
    expect(s).toContain('/Title (All views)')
    expect(s).toContain('/MediaBox [0 0 3 1.5]')
    // Every object starts where the table says.
    const xref = Number(/startxref\n(\d+)/.exec(s)![1])
    const rows = s.slice(xref).split('\n').slice(3, 3 + 9)
    rows.forEach((row, i) => expect(s.slice(Number(row.slice(0, 10)), Number(row.slice(0, 10)) + 8)).toBe(`${i + 1} 0 obj\n`.slice(0, 8)))
    // The first picture's pixels, decompressed: RGB without alpha.
    const start = s.indexOf('stream\n', s.indexOf('/Subtype /Image')) + 7
    const length = Number(/\/Subtype \/Image[^>]*\/Length (\d+)/.exec(s)![1])
    expect([...unzlibSync(pdf.slice(start, start + length))]).toEqual(new Array(4 * 2 * 3).fill(200))
  })
})
