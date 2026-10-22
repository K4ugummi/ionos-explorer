import { generateX25519Identity, identityToRecipient } from 'age-encryption'
import { describe, expect, it } from 'vitest'
import { compareModels } from '../diff/diff'
import { EncryptedSnapshotError, isEncrypted, loadSnapshot } from '../snapshot/load'
import type { Manifest } from '../snapshot/types'
import { fixtureBytes, fixtureModel, previousFixtureModel } from '../test/fixture'
import { encryptSnapshot } from './encrypt'
import type { HistoryEntry } from './backend'
import { comparisonBase, historyBase, historyContract, parseRecipients, sizeText, snapshotFileName } from './snapshots'

const manifest = (contract: number | undefined, createdAt: string) => ({
  manifest: { contract: contract === undefined ? undefined : { number: contract }, createdAt } as Manifest,
})

describe('comparison base of a fresh fetch', () => {
  it('is the snapshot open before, when it is the same contract and older', async () => {
    const [before, now] = await Promise.all([previousFixtureModel(), fixtureModel()])
    expect(comparisonBase(before, now)).toBe(before)
    // And that gives a diff, from memory alone.
    const diff = compareModels(comparisonBase(before, now)!, now)
    expect(diff.changes.length).toBeGreaterThan(0)
  })

  it('is nothing otherwise', () => {
    const now = manifest(1, '2026-10-15T08:00:00Z')
    expect(comparisonBase(undefined, now)).toBeUndefined()
    expect(comparisonBase(manifest(2, '2026-10-01T08:00:00Z'), now)).toBeUndefined() // another contract
    expect(comparisonBase(manifest(1, '2026-10-15T08:00:00Z'), now)).toBeUndefined() // the same time
    expect(comparisonBase(manifest(1, '2026-10-16T08:00:00Z'), now)).toBeUndefined() // newer (a file opened meanwhile)
    expect(comparisonBase(manifest(undefined, '2026-10-01T08:00:00Z'), manifest(undefined, '2026-10-15T08:00:00Z'))).toBeUndefined()
  })
})

describe('download', () => {
  it('names files like ionos-export', () => {
    const m = { contract: { number: 31812345 }, createdAt: '2026-10-15T08:19:04Z' }
    expect(snapshotFileName(m, false)).toBe('ionos-31812345-20261015T081904Z.ionx')
    expect(snapshotFileName({ ...m, createdAt: '2026-10-15T08:19:04.123Z' }, true)).toBe('ionos-31812345-20261015T081904Z.ionx.age')
    expect(snapshotFileName({ createdAt: '2026-10-15T10:19:04+02:00' }, false)).toBe('ionos-20261015T081904Z.ionx')
    expect(snapshotFileName({ createdAt: 'nonsense' }, false)).toBe('ionos-unknown.ionx')
  })

  it('leaves the bytes as they are without encryption', async () => {
    const data = fixtureBytes()
    expect(await encryptSnapshot(data, { kind: 'none' })).toBe(data)
  })

  it('encrypts with a passphrase the explorer opens again', async () => {
    const enc = await encryptSnapshot(fixtureBytes(), { kind: 'passphrase', passphrase: 'correct horse' }, 10)
    expect(isEncrypted(enc)).toBe(true)
    await expect(loadSnapshot(enc, 'wrong')).rejects.toBeInstanceOf(EncryptedSnapshotError)
    expect((await loadSnapshot(enc, 'correct horse')).manifest.contract?.number).toBe(31812345)
  })

  it('encrypts to age recipients', async () => {
    const [a, b] = await Promise.all([generateX25519Identity(), generateX25519Identity()])
    const text = `# team\n${await identityToRecipient(a)}\n  ${await identityToRecipient(b)}  # me\n`
    const recipients = parseRecipients(text)
    expect(recipients).toHaveLength(2)
    const enc = await encryptSnapshot(fixtureBytes(), { kind: 'recipients', recipients })
    for (const id of [a, b]) expect((await loadSnapshot(enc, id)).files.size).toBeGreaterThan(0)
  })

  it('refuses what it cannot encrypt to', async () => {
    const data = new Uint8Array([1, 2, 3])
    await expect(encryptSnapshot(data, { kind: 'passphrase', passphrase: '' })).rejects.toThrow('Enter a passphrase')
    await expect(encryptSnapshot(data, { kind: 'recipients', recipients: [] })).rejects.toThrow('at least one')
    await expect(encryptSnapshot(data, { kind: 'recipients', recipients: ['ssh-ed25519 AAAA'] })).rejects.toThrow('Not an age recipient')
    await expect(encryptSnapshot(data, { kind: 'recipients', recipients: ['age1nope'] })).rejects.toThrow(/age recipient|Could not encrypt/)
  })
})

describe('history', () => {
  const entry = (id: string, contract: string, createdAt: string): HistoryEntry => ({
    id,
    contract,
    createdAt,
    collections: 1,
    problems: 0,
    partial: false,
    size: 1,
    stored: 1,
  })

  it('names the contract folder', () => {
    expect(historyContract({ contract: { number: 1234 } } as Manifest)).toBe('1234')
    expect(historyContract({} as Manifest)).toBe('unknown')
  })

  it('compares with the newest older snapshot of the same contract, not with itself', () => {
    const m = { contract: { number: 1 }, createdAt: '2026-10-15T08:00:00Z' } as Manifest
    const entries = [
      entry('self', '1', '2026-10-15T08:00:00Z'),
      entry('newer', '1', '2026-10-16T08:00:00Z'),
      entry('other', '2', '2026-10-14T23:00:00Z'),
      entry('older', '1', '2026-10-10T08:00:00Z'),
      entry('newest-older', '1', '2026-10-14T08:00:00Z'),
    ]
    expect(historyBase(entries, m, 'self')?.id).toBe('newest-older')
    expect(historyBase(entries.slice(0, 3), m, 'self')).toBeUndefined()
    // Same time, another ID (fetched twice in a second): not older.
    expect(historyBase([entry('twin', '1', '2026-10-15T08:00:00Z')], m, 'self')).toBeUndefined()
  })

  it('words sizes', () => {
    expect(sizeText(500)).toBe('500 B')
    expect(sizeText(1536)).toBe('1.5 KB')
    expect(sizeText(225 * 1024)).toBe('225 KB')
    expect(sizeText(500 * 1024 * 1024)).toBe('500 MB')
    expect(sizeText(3 * 1024 ** 3)).toBe('3.0 GB')
  })
})
