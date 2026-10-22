import type { Manifest } from '../snapshot/types'
import type { HistoryEntry } from './backend'

/**
 * The snapshot a freshly fetched one is compared with: the one open before
 * it, if it is of the same contract and older. So fetching again shows what
 * changed, without any file.
 */
export function comparisonBase<T extends { manifest: Manifest }>(previous: T | undefined, next: { manifest: Manifest }): T | undefined {
  if (!previous) return undefined
  const [a, b] = [previous.manifest, next.manifest]
  if (a.contract?.number === undefined || a.contract.number !== b.contract?.number) return undefined
  return new Date(a.createdAt) < new Date(b.createdAt) ? previous : undefined
}

/** The history folder of a snapshot's contract (server: history.contractDir). */
export function historyContract(m: Pick<Manifest, 'contract'>): string {
  const n = m.contract?.number
  return n !== undefined && n > 0 ? String(n) : 'unknown'
}

/**
 * The snapshot of the history a newly opened one is compared with: the
 * newest older one of the same contract, not the snapshot itself.
 */
export function historyBase(entries: HistoryEntry[], m: Pick<Manifest, 'contract' | 'createdAt'>, self?: string): HistoryEntry | undefined {
  const at = new Date(m.createdAt).getTime()
  const contract = historyContract(m)
  return entries
    .filter((e) => e.contract === contract && e.id !== self && new Date(e.createdAt).getTime() < at)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]
}

/** "1.2 MB" */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/** As ionos-export names its files: ionos-<contract>-<UTC time>.ionx(.age). */
export function snapshotFileName(m: Pick<Manifest, 'contract' | 'createdAt'>, encrypted: boolean): string {
  const t = new Date(m.createdAt)
  const time = Number.isNaN(t.getTime())
    ? 'unknown'
    : t
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d+Z$/, 'Z')
  const contract = m.contract?.number !== undefined ? `-${m.contract.number}` : ''
  return `ionos${contract}-${time}.ionx${encrypted ? '.age' : ''}`
}

export type Encryption = { kind: 'none' } | { kind: 'passphrase'; passphrase: string } | { kind: 'recipients'; recipients: string[] }

/** age recipients from a text field: one per line or separated by spaces; # comments allowed. */
export function parseRecipients(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .flatMap((l) => l.split(/\s+/))
    .filter(Boolean)
}

/** Hands bytes to the browser's downloads. */
export function download(data: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/octet-stream' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.style.display = 'none'
  document.body.append(a)
  a.click()
  a.remove()
  // Some browsers read the URL only after the click has been handled.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
