import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { useDismiss } from './dismiss'
import { exportDrawio, exportFileName, exportSvg, saveFile, svgToPng, type ExportInfo } from './export'
import type { Layout } from './types'

type Format = 'svg' | 'png' | 'drawio'

const FORMATS: { id: Format; label: string; note: string }[] = [
  { id: 'svg', label: 'SVG image', note: 'Sharp at any size, for documents' },
  { id: 'png', label: 'PNG image', note: 'At twice the size, for slides and tickets' },
  { id: 'drawio', label: 'draw.io file', note: 'To edit in diagrams.net' },
]

/**
 * The "Export" button in the diagram bar and its popover: the current view
 * as it is laid out (own positions, hidden layers, collapsed groups),
 * without selection or search dimming, saved as a file in the browser.
 * Nothing is uploaded.
 */
export function ExportMenu({ source }: { source: () => { layout: Layout; info: ExportInfo } | undefined }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<Format>()
  const [error, setError] = useState<string>()
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
    if (open) pop.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [open])

  const run = async (format: Format) => {
    const s = source()
    if (!s) return
    setBusy(format)
    setError(undefined)
    try {
      const name = exportFileName(s.info, format)
      if (format === 'drawio') {
        saveFile(new Blob([exportDrawio(s.layout, s.info)], { type: 'application/xml' }), name)
      } else {
        const { svg, width, height } = exportSvg(s.layout, s.info)
        const blob = format === 'svg' ? new Blob([svg], { type: 'image/svg+xml' }) : (await svgToPng(svg, width, height)).blob
        saveFile(blob, name)
      }
      close()
      toggle.current?.focus()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(undefined)
    }
  }

  // Up and down move between the formats, as in a menu; Tab works too.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = [...(pop.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
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
        title="Save this view as SVG, PNG or draw.io file"
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
          aria-label="Export this view"
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
