import { createContext } from 'react'
import type { Diff } from './diff'

/** The comparison with an older snapshot, when one is loaded. */
export const CompareContext = createContext<Diff | undefined>(undefined)
