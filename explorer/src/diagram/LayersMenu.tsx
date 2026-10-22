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

/** Groups of the current view: open or close all of them at once. */
export interface GroupActions {
  /** Some group or router is collapsed. */
  canExpand: boolean
  /** Some group or router is open. */
  canCollapse: boolean
  expand: () => void
  collapse: () => void
}

/**
 * The "Layers" button in the diagram bar and its popover: which kinds of
 * things the diagram shows, and what it emphasises. Layers that do not apply
 * to the current view stay visible but greyed out, so the choice is clear.
 * Below them, for views that have them: opening or closing all groups, and
 * snapping moved boxes to the grid.
 */
export function LayersMenu({
  layers,
  onChange,
  scope,
  comparing,
  groups,
  snap,
  onSnap,
}: {
  layers: Layers
  onChange: (next: Layers) => void
  /** Which layers apply: all in a datacenter (and a focus) view, links on the contract view, none on a path. */
  scope: 'contract' | 'datacenter' | 'path'
  comparing: boolean
  groups?: GroupActions
  /** Boxes can be moved in this view: whether a dropped box snaps to the grid. */
  snap?: boolean
  onSnap?: (on: boolean) => void
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
          {(groups || onSnap) && (
            <fieldset>
              <legend>Arrange</legend>
              {groups && (
                <div className="dg-layers-buttons">
                  <button
                    type="button"
                    className="btn small"
                    disabled={!groups.canExpand}
                    onClick={groups.expand}
                    title="Show every member of the large groups, and the LANs folded into routers"
                  >
                    Expand all
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    disabled={!groups.canCollapse}
                    onClick={groups.collapse}
                    title="Fold the large groups and the routers' LANs again"
                  >
                    Collapse all
                  </button>
                </div>
              )}
              {onSnap && (
                <label title="A box you drop lands on the dots of the background">
                  <input type="checkbox" checked={!!snap} onChange={(e) => onSnap(e.target.checked)} />
                  Snap moved boxes to the grid
                </label>
              )}
              {onSnap && <p className="dg-layers-note">Shift and drag to pick several boxes, then move them together.</p>}
            </fieldset>
          )}
        </div>
      )}
    </div>
  )
}
