import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useDismiss } from './dismiss'
import { LAYERS, type Emphasis, type Layers } from './layers'

const EMPHASES: { id?: Emphasis; label: string }[] = [
  { label: 'Everything' },
  { id: 'appliances', label: 'Only appliances' },
  { id: 'changes', label: 'Only changes' },
]

/** Why layers are greyed out. */
const NOTE = {
  contract: "Only in a datacenter's diagram.",
  path: 'A path shows everything it passes.',
  datacenter: '',
}

/**
 * The "Layers" button in the diagram bar and its popover: which kinds of
 * things the diagram shows, and what it emphasises. Layers that do not apply
 * to the current view stay visible but greyed out, so the choice is clear.
 */
export function LayersMenu({
  layers,
  onChange,
  scope,
  comparing,
}: {
  layers: Layers
  onChange: (next: Layers) => void
  /** Which layers apply: all in a datacenter (and a focus) view, links on the contract view, none on a path. */
  scope: 'contract' | 'datacenter' | 'path'
  comparing: boolean
}) {
  const [open, setOpen] = useState(false)
  const area = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const id = useId()
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, close, area, toggle)
  // Opened: the keyboard goes on into the choices.
  useEffect(() => {
    if (open) pop.current?.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus()
  }, [open])

  const emphasis = layers.emphasis === 'changes' && !comparing ? undefined : layers.emphasis
  const active = layers.hidden.size + (emphasis ? 1 : 0)
  const show = (layer: (typeof LAYERS)[number]['id'], on: boolean) => {
    const hidden = new Set(layers.hidden)
    if (on) hidden.delete(layer)
    else hidden.add(layer)
    onChange({ ...layers, hidden })
  }

  return (
    <div className="dg-layers" ref={area}>
      <button
        ref={toggle}
        className="btn small"
        aria-expanded={open}
        aria-controls={id}
        title={active ? `${active} ${active === 1 ? 'layer' : 'layers'} switched off or emphasised` : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        Layers
        {active > 0 && <span className="dg-layers-count">{active}</span>}
      </button>
      {open && (
        <div className="dg-pop dg-layers-pop" id={id} ref={pop} role="group" aria-label="Layers">
          <fieldset>
            <legend>Show</legend>
            {LAYERS.map((l) => {
              const applies = scope === 'datacenter' || (scope === 'contract' && !!l.contract)
              return (
                <label key={l.id} title={applies ? l.title : `${l.title}. ${NOTE[scope]}`}>
                  <input
                    type="checkbox"
                    checked={!layers.hidden.has(l.id)}
                    disabled={!applies}
                    onChange={(e) => show(l.id, e.target.checked)}
                  />
                  {l.label}
                </label>
              )
            })}
            {scope !== 'datacenter' && <p className="dg-layers-note">Greyed out: {NOTE[scope].toLowerCase()}</p>}
          </fieldset>
          <fieldset>
            <legend>Emphasise</legend>
            {EMPHASES.map((x) => {
              const off = x.id === 'changes' && !comparing
              return (
                <label key={x.label} title={off ? 'Compare with an older snapshot on the Changes tab first' : undefined}>
                  <input
                    type="radio"
                    name={`${id}-emphasis`}
                    checked={emphasis === x.id}
                    disabled={off}
                    onChange={() => onChange({ ...layers, emphasis: x.id })}
                  />
                  {x.label}
                </label>
              )
            })}
            {!comparing && <p className="dg-layers-note">"Only changes" needs a comparison (Changes tab).</p>}
          </fieldset>
        </div>
      )}
    </div>
  )
}
