import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { Decrypter } from 'age-encryption'
import { unzipSync } from 'fflate'
import { SUPPORTED_FORMAT_VERSION, type Manifest, type Snapshot } from './types'

const AGE_MAGIC = new TextEncoder().encode('age-encryption.org/v1')

export class SnapshotError extends Error {}

/** Thrown when the file is age-encrypted and no (valid) secret was given. */
export class EncryptedSnapshotError extends SnapshotError {}

export function isEncrypted(data: Uint8Array): boolean {
  return data.length >= AGE_MAGIC.length && AGE_MAGIC.every((b, i) => data[i] === b)
}

/**
 * Decrypt (if needed), unzip and verify a .ionx snapshot. `secret` is either
 * an age identity (AGE-SECRET-KEY-1...) or a passphrase.
 */
export async function loadSnapshot(data: Uint8Array, secret?: string): Promise<Snapshot> {
  if (isEncrypted(data)) {
    if (!secret) throw new EncryptedSnapshotError('This snapshot is encrypted. Enter the passphrase or age identity.')
    const d = new Decrypter()
    const trimmed = secret.trim()
    if (trimmed.startsWith('AGE-SECRET-KEY-')) d.addIdentity(trimmed)
    else d.addPassphrase(secret)
    try {
      data = await d.decrypt(data, 'uint8array')
    } catch {
      throw new EncryptedSnapshotError('Could not decrypt: wrong passphrase or identity.')
    }
  }

  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(data)
  } catch {
    throw new SnapshotError('Not a snapshot file (expected a .ionx zip container).')
  }

  const manifestBytes = entries['manifest.json']
  if (!manifestBytes) throw new SnapshotError('Snapshot has no manifest.json.')
  const decoder = new TextDecoder()
  const manifest = JSON.parse(decoder.decode(manifestBytes)) as Manifest
  if (typeof manifest.formatVersion !== 'number' || !Array.isArray(manifest.files)) {
    throw new SnapshotError('manifest.json is not a snapshot manifest.')
  }
  if (manifest.formatVersion > SUPPORTED_FORMAT_VERSION) {
    throw new SnapshotError(
      `Snapshot format ${manifest.formatVersion} is newer than this explorer supports (${SUPPORTED_FORMAT_VERSION}). Update the explorer.`,
    )
  }

  const files = new Map<string, unknown>()
  const listed = new Set<string>()
  for (const f of manifest.files) {
    listed.add(f.path)
    const bytes = entries[f.path]
    if (!bytes) throw new SnapshotError(`${f.path} is listed in the manifest but missing.`)
    if (bytesToHex(sha256(bytes)) !== f.sha256) throw new SnapshotError(`${f.path} failed its checksum. The file is corrupt or was modified.`)
    files.set(f.path, JSON.parse(decoder.decode(bytes)))
  }
  for (const name of Object.keys(entries)) {
    if (name !== 'manifest.json' && !name.endsWith('/') && !listed.has(name)) {
      throw new SnapshotError(`${name} is not listed in the manifest.`)
    }
  }
  return { manifest, files }
}
