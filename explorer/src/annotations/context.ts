import { createContext } from 'react'
import type { Annotations, IpFix, ManualLink } from './annotations'

export interface AnnotationsState {
  annotations: Annotations
  update: (fn: (a: Annotations) => Annotations) => void
  /** Links whose ends are not in the open snapshot. */
  dangling: ManualLink[]
  /** IP corrections for NICs that are not in the open snapshot. */
  staleIps: IpFix[]
  contract?: number
}

export const AnnotationsContext = createContext<AnnotationsState | null>(null)
