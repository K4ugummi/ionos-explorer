import type { Manifest } from '../snapshot/types'

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
