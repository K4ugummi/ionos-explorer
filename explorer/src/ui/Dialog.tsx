import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * A modal <dialog>: focus stays inside, Escape and the ✕ close it, focus
 * returns to the opener. Rendered into <body>, so it is never inside the
 * opener's form; and submit events stop here, as React would otherwise pass
 * them on through the portal to such a form.
 */
export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    if (ref.current && !ref.current.open) ref.current.showModal()
    // The parent may drop the dialog without closing it (a fetch landed): focus goes back as on Escape.
    // No close() here, it would report a close.
    return () => opener?.focus()
  }, [])
  return createPortal(
    <dialog
      ref={ref}
      className={wide ? 'modal wide' : 'modal'}
      aria-labelledby={id}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && ref.current.close()} // the backdrop
      onSubmit={(e) => e.stopPropagation()}
    >
      <div className="modal-inner">
        <div className="modal-head">
          <h2 id={id}>{title}</h2>
          <button type="button" className="btn small" onClick={() => ref.current?.close()} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </dialog>,
    document.body,
  )
}
