import { Encrypter, generateX25519Identity, identityToRecipient } from 'age-encryption'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { fixtureBytes } from '../test/fixture'
import { EncryptedSnapshotError, SnapshotError, isEncrypted, loadSnapshot } from './load'

describe('loadSnapshot', () => {
  it('loads and verifies the demo fixture', async () => {
    const s = await loadSnapshot(fixtureBytes())
    expect(s.manifest.formatVersion).toBe(1)
    expect(s.manifest.synthetic).toBe(true)
    expect(s.files.size).toBe(s.manifest.files.length)
  })

  it('decrypts with a passphrase', async () => {
    const e = new Encrypter()
    e.setPassphrase('correct horse')
    // Keep the test fast: the default scrypt work factor is meant for real use.
    e.setScryptWorkFactor(10)
    const enc = await e.encrypt(fixtureBytes())
    expect(isEncrypted(enc)).toBe(true)
    await expect(loadSnapshot(enc)).rejects.toBeInstanceOf(EncryptedSnapshotError)
    await expect(loadSnapshot(enc, 'wrong')).rejects.toBeInstanceOf(EncryptedSnapshotError)
    const s = await loadSnapshot(enc, 'correct horse')
    expect(s.files.size).toBeGreaterThan(0)
  })

  it('decrypts with an age identity', async () => {
    const id = await generateX25519Identity()
    const e = new Encrypter()
    e.addRecipient(await identityToRecipient(id))
    const s = await loadSnapshot(await e.encrypt(fixtureBytes()), `  ${id}\n`)
    expect(s.files.size).toBeGreaterThan(0)
  })

  it('rejects tampered files', async () => {
    const entries = unzipSync(fixtureBytes())
    const victim = Object.keys(entries).find((k) => k.startsWith('raw/'))!
    entries[victim] = strToU8('{"items":[]}')
    await expect(loadSnapshot(zipSync(entries))).rejects.toThrow(/checksum/)
  })

  it('rejects unlisted files and newer formats', async () => {
    const entries = unzipSync(fixtureBytes())
    await expect(loadSnapshot(zipSync({ ...entries, 'raw/extra.json': strToU8('{}') }))).rejects.toThrow(/not listed/)
    const m = JSON.parse(new TextDecoder().decode(entries['manifest.json']))
    m.formatVersion = 99
    await expect(loadSnapshot(zipSync({ ...entries, 'manifest.json': strToU8(JSON.stringify(m)) }))).rejects.toThrow(/newer/)
  })

  it('rejects non-snapshots', async () => {
    await expect(loadSnapshot(strToU8('hello'))).rejects.toBeInstanceOf(SnapshotError)
  })
})
