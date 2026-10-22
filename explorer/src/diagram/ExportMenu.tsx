import { strToU8, zipSync } from 'fflate'
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { useDismiss } from './dismiss'
import {
  exportDrawio,
  exportDrawioPages,
  exportFileName,
  exportSvg,
  saveFile,
  svgToCanvas,
  svgToPng,
  type ExportExt,
  type ExportInfo,
} from './export'
import { makePdf, pageSize, type PdfPage } from './pdf'
import type { Layout } from './types'

export interface ExportSource {
  layout: Layout
  info: ExportInfo
}

type Format = 'svg' | 'png' | 'pdf' | 'drawio'
type AllFormat = 'pdf' | 'drawio' | 'zip'

const FORMATS: { id: Format; label: string; note: string }[] = [
  { id: 'svg', label: 'SVG image', note: 'Sharp at any size, for documents' },
  { id: 'png', label: 'PNG image', note: 'For slides and tickets' },
  { id: 'pdf', label: 'PDF', note: 'One page the size of the picture, to print or attach' },
  { id: 'drawio', label: 'draw.io file', note: 'To edit in diagrams.net' },
]

const ALL_FORMATS: { id: AllFormat; label: string; note: string }[] = [
  { id: 'pdf', label: 'PDF', note: 'One page per view' },
  { id: 'drawio', label: 'draw.io file', note: 'One page (tab) per view' },
  { id: 'zip', label: 'SVG images in a ZIP', note: 'One file per view' },
]

const SCALES = [1, 2, 4]

/** Pixels per PDF page at most: enough for print, small enough for the browser's memory. */
const PDF_PIXELS = 30_000_000

/** The PNG options, kept in this browser. */
const PNG_KEY = 'ionos-explorer:export-png'

function loadPng(): { scale: number; transparent: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(PNG_KEY) ?? '{}') as { scale?: unknown; transparent?: unknown }
    return { scale: SCALES.includes(v.scale as number) ? (v.scale as number) : 2, transparent: v.transparent === true }
  } catch {
    return { scale: 2, transparent: false }
  }
}

function savePng(v: { scale: number; transparent: boolean }) {
  try {
    localStorage.setItem(PNG_KEY, JSON.stringify(v))
  } catch {
    // Storage disabled: the options last as long as the page.
  }
}

/** One PDF page per view, each at twice its size where the memory allows. */
async function pdfOf(sources: ExportSource[]): Promise<Blob> {
  const pages: PdfPage[] = []
  for (const s of sources) {
    const { svg, width, height } = exportSvg(s.layout, s.info)
    const { canvas } = await svgToCanvas(svg, width, height, 2, PDF_PIXELS)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('No canvas available')
    pages.push({ rgba: ctx.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height, ...pageSize(width, height) })
    canvas.width = canvas.height = 0 // frees the pixels before the next page
  }
  const title = sources.length === 1 ? sources[0].info.title : `${sources[0]?.info.title ?? 'Diagram'} and ${sources.length - 1} more views`
  return new Blob([makePdf(pages, title) as Uint8Array<ArrayBuffer>], { type: 'application/pdf' })
}

/**
 * The "Export" button in the diagram bar and its popover: the current view
 * as it is laid out (own positions, hidden layers, collapsed groups),
 * without selection or search dimming, saved as a file in the browser; or
 * every view of the contract at once (`all`: the overview and each
 * datacenter, laid out with the same layers and own positions). Nothing is
 * uploaded.
 */
export function ExportMenu({
  source,
  all,
}: {
  source: () => ExportSource | undefined
  /** Lays out every view; `progress` reports how far. */
  all?: (progress: (done: number, of: number) => void) => Promise<{ sources: ExportSource[]; name: ExportInfo }>
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string>()
  const [status, setStatus] = useState<string>()
  const [error, setError] = useState<string>()
  const [png, setPng] = useState(loadPng)
  const area = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const id = useId()
  const close = useCallback(() => {
    setOpen(false)
    setError(undefined)
  }, [])
  useDismiss(open, close, area, toggle)
  // Opened: the keyboard goes on into the choices.
  useEffect(() => {
    if (open) pop.current?.querySelector<HTMLButtonElement>('button.dg-export-item')?.focus()
  }, [open])
  const changePng = (next: { scale: number; transparent: boolean }) => {
    setPng(next)
    savePng(next)
  }

  const saving = async (key: string, work: () => Promise<void>) => {
    setBusy(key)
    setError(undefined)
    try {
      await work()
      close()
      toggle.current?.focus()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(undefined)
      setStatus(undefined)
    }
  }

  const run = (format: Format) =>
    saving(format, async () => {
      const s = source()
      if (!s) return
      const name = exportFileName(s.info, format)
      if (format === 'drawio') return saveFile(new Blob([exportDrawio(s.layout, s.info)], { type: 'application/xml' }), name)
      if (format === 'pdf') return saveFile(await pdfOf([s]), name)
      const { svg, width, height } = exportSvg(s.layout, s.info, { transparent: format === 'png' && png.transparent })
      saveFile(format === 'svg' ? new Blob([svg], { type: 'image/svg+xml' }) : (await svgToPng(svg, width, height, png.scale)).blob, name)
    })

  const runAll = (format: AllFormat) =>
    saving(`all-${format}`, async () => {
      if (!all) return
      const { sources, name } = await all((done, of) => setStatus(`Laying out view ${Math.min(done + 1, of)} of ${of}…`))
      setStatus(undefined)
      const file = (ext: ExportExt) => exportFileName({ ...name, view: 'all-views' }, ext)
      if (format === 'drawio') return saveFile(new Blob([exportDrawioPages(sources)], { type: 'application/xml' }), file('drawio'))
      if (format === 'pdf') return saveFile(await pdfOf(sources), file('pdf'))
      const files: Record<string, Uint8Array> = {}
      for (const s of sources) {
        let n = exportFileName(s.info, 'svg')
        for (let i = 2; files[n]; i++) n = exportFileName({ ...s.info, view: `${s.info.view}-${i}` }, 'svg')
        files[n] = strToU8(exportSvg(s.layout, s.info).svg)
      }
      saveFile(new Blob([zipSync(files, { level: 6 }) as Uint8Array<ArrayBuffer>], { type: 'application/zip' }), file('zip'))
    })

  // Up and down move between the formats, as in a menu; Tab works too.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = [...(pop.current?.querySelectorAll<HTMLButtonElement>('button.dg-export-item') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    if (i < 0) return
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
    e.preventDefault()
  }

  return (
    <div className="dg-export" ref={area}>
      <button
        ref={toggle}
        className="btn small"
        aria-expanded={open}
        aria-controls={id}
        title="Save this view, or all of them, as SVG, PNG, PDF or draw.io file"
        aria-label="Export"
        onClick={() => (open ? close() : setOpen(true))}
      >
        {/* On a narrow screen only the icon, so the breadcrumbs keep their room. */}
        <svg className="dg-export-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden>
          <path
            d="M8 2v8M4.5 6.5 8 10l3.5-3.5M3 13h10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="dg-wide">Export</span>
      </button>
      {open && (
        <div
          className="dg-export-pop"
          id={id}
          ref={pop}
          role="group"
          aria-label="Export"
          aria-busy={!!busy}
          onKeyDown={onKeyDown}
        >
          <p className="dg-export-note">This view as you see it, without selection or search; saved on this computer.</p>
          {FORMATS.map((f) => (
            <button key={f.id} type="button" className="dg-export-item" disabled={!!busy} onClick={() => void run(f.id)}>
              <span className="t">{busy === f.id ? `Saving ${f.label}…` : f.label}</span>
              <span className="s">{f.note}</span>
            </button>
          ))}
          <div className="dg-export-opts" role="group" aria-label="PNG options">
            <span className="dg-export-opt-label">PNG</span>
            <div className="seg" role="radiogroup" aria-label="PNG size">
              {SCALES.map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={png.scale === k}
                  title={`${k} pixel${k === 1 ? '' : 's'} per point of the diagram`}
                  onClick={() => changePng({ ...png, scale: k })}
                >
                  {k}×
                </button>
              ))}
            </div>
            <label>
              <input type="checkbox" checked={png.transparent} onChange={(e) => changePng({ ...png, transparent: e.target.checked })} />
              Transparent background
            </label>
          </div>
          {all && (
            <>
              <p className="dg-export-note dg-export-all">
                All views: the overview and every datacenter, with the layers and moved boxes they have now.
              </p>
              {ALL_FORMATS.map((f) => (
                <button key={f.id} type="button" className="dg-export-item" disabled={!!busy} onClick={() => void runAll(f.id)}>
                  <span className="t">{busy === `all-${f.id}` ? (status ?? `Saving ${f.label}…`) : f.label}</span>
                  <span className="s">{f.note}</span>
                </button>
              ))}
            </>
          )}
          {error && (
            <p className="dg-export-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
