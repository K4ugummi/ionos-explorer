import { useEffect, type RefObject } from 'react'

/**
 * Closes a popover on Escape (focus goes back to its button), on a pointer
 * down outside `area`, and when focus leaves `area` (Tab past its end).
 */
export function useDismiss(open: boolean, close: () => void, area: RefObject<HTMLElement | null>, toggle: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return
    const outside = (t: EventTarget | null) => !area.current?.contains(t as Node)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      close()
      toggle.current?.focus()
    }
    const onPointer = (e: PointerEvent) => outside(e.target) && close()
    const onFocus = (e: FocusEvent) => outside(e.target) && close()
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('focusin', onFocus)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('focusin', onFocus)
    }
  }, [open, close, area, toggle])
}
