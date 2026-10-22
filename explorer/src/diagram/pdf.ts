import { zlibSync } from 'fflate'

/**
 * A minimal PDF writer for exported views: one page per picture, each page
 * the picture's size, the picture stored lossless (RGB, Flate), so text
 * and thin lines stay sharp. No fonts, no scripts, nothing else.
 */
export interface PdfPage {
  /** Pixels, RGBA (as a canvas returns them), `width` × `height`. */
  rgba: Uint8ClampedArray
  width: number
  height: number
  /** Page size in points (1/72 inch). */
  pageWidth: number
  pageHeight: number
}

/** Acrobat's largest page side, in points (200 inches). */
export const MAX_PAGE_SIDE = 14_400

/** The page size for a picture of `width` × `height` CSS pixels (96 per inch), shrunk to fit `MAX_PAGE_SIDE`. */
export function pageSize(width: number, height: number): { pageWidth: number; pageHeight: number } {
  const k = Math.min(0.75, MAX_PAGE_SIDE / Math.max(1, width, height))
  return { pageWidth: round(width * k), pageHeight: round(height * k) }
}

const round = (v: number) => Math.round(v * 100) / 100

/** Alpha dropped: transparent pixels count as white, the paper's colour. */
export function rgbOf(rgba: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array((rgba.length / 4) * 3)
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    const a = rgba[i + 3] / 255
    out[j] = Math.round(rgba[i] * a + 255 * (1 - a))
    out[j + 1] = Math.round(rgba[i + 1] * a + 255 * (1 - a))
    out[j + 2] = Math.round(rgba[i + 2] * a + 255 * (1 - a))
  }
  return out
}

/** PDF text string: ASCII as is (escaped), anything else as UTF-16BE in hex. */
export function pdfString(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`
  let hex = 'FEFF'
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase()
  return `<${hex}>`
}

export function makePdf(pages: PdfPage[], title: string): Uint8Array {
  const enc = new TextEncoder()
  const chunks: Uint8Array[] = []
  const offsets: number[] = []
  let length = 0
  const put = (b: Uint8Array | string) => {
    const bytes = typeof b === 'string' ? enc.encode(b) : b
    chunks.push(bytes)
    length += bytes.length
  }
  // Object numbers: 1 catalog, 2 page tree, 3 info, then three per page (page, contents, image).
  const pageObj = (i: number) => 4 + 3 * i
  const object = (n: number, body: () => void) => {
    offsets[n] = length
    put(`${n} 0 obj\n`)
    body()
    put('\nendobj\n')
  }

  put('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
  object(1, () => put('<< /Type /Catalog /Pages 2 0 R >>'))
  object(2, () => put(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`))
  object(3, () => put(`<< /Title ${pdfString(title)} /Producer (IONOS Explorer) >>`))
  pages.forEach((p, i) => {
    const n = pageObj(i)
    const content = `q ${p.pageWidth} 0 0 ${p.pageHeight} 0 0 cm /Im0 Do Q`
    object(n, () =>
      put(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.pageWidth} ${p.pageHeight}] ` +
          `/Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`,
      ),
    )
    object(n + 1, () => put(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`))
    const data = zlibSync(rgbOf(p.rgba), { level: 6 })
    object(n + 2, () => {
      put(
        `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB ` +
          `/BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`,
      )
      put(data)
      put('\nendstream')
    })
  })
  const count = 4 + 3 * pages.length
  const xref = length
  put(`xref\n0 ${count}\n0000000000 65535 f \n`)
  for (let n = 1; n < count; n++) put(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`)
  put(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`)

  const out = new Uint8Array(length)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}
