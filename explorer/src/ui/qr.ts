import qrcode from 'qrcode-generator'

/**
 * The modules of a QR code for text (error correction M, the smallest
 * version that holds it), true for dark, without the quiet zone.
 */
export function qrModules(text: string): boolean[][] {
  const qr = qrcode(0, 'M')
  qr.addData(text, 'Byte')
  qr.make()
  const n = qr.getModuleCount()
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)))
}

/** An SVG path of the dark modules, one unit each, shifted by the quiet zone. */
export function qrPath(modules: boolean[][], quiet = 4): string {
  const parts: string[] = []
  modules.forEach((row, r) => {
    let c = 0
    while (c < row.length) {
      if (!row[c]) {
        c++
        continue
      }
      const start = c
      while (c < row.length && row[c]) c++
      parts.push(`M${start + quiet} ${r + quiet}h${c - start}v1h${start - c}z`)
    }
  })
  return parts.join('')
}
