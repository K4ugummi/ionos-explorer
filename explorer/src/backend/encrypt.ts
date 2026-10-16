// Its own module, loaded when a download is encrypted: the encrypting half
// of age-encryption is not needed to open snapshots.
import { Encrypter } from 'age-encryption'
import type { Encryption } from './snapshots'

/**
 * Encrypts like `ionos-export --passphrase-file` / `--recipient`, in the
 * browser (age-encryption). `workFactor` only for tests: scrypt's default
 * is meant for real use.
 */
export async function encryptSnapshot(data: Uint8Array, enc: Encryption, workFactor?: number): Promise<Uint8Array> {
  if (enc.kind === 'none') return data
  const e = new Encrypter()
  if (enc.kind === 'passphrase') {
    if (!enc.passphrase) throw new Error('Enter a passphrase.')
    e.setPassphrase(enc.passphrase)
    if (workFactor) e.setScryptWorkFactor(workFactor)
  } else {
    if (!enc.recipients.length) throw new Error('Enter at least one age recipient (age1…).')
    for (const r of enc.recipients) {
      try {
        if (!r.startsWith('age1')) throw new Error()
        e.addRecipient(r) // X25519, post-quantum hybrid and tag recipients
      } catch {
        throw new Error(`Not an age recipient: ${r.length > 24 ? r.slice(0, 24) + '…' : r}`)
      }
    }
  }
  try {
    return await e.encrypt(data)
  } catch (err) {
    // An invalid recipient may only show when it is used.
    throw new Error(`Could not encrypt: ${err instanceof Error ? err.message : String(err)}`)
  }
}
