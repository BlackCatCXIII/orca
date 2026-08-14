import { createHash, timingSafeEqual } from 'node:crypto'
import type { SshHostKeyPin } from '../../shared/ssh-host-key-pin'
import {
  decodeOpenSshPublicKey,
  decodeOpenSshSha256Fingerprint
} from '../../shared/ssh-host-key-pin'

export function formatOpenSshSha256Fingerprint(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
  return `SHA256:${digest}`
}

export function verifySshHostKey(pin: SshHostKeyPin | undefined, key: Buffer): boolean {
  if (pin === undefined) {
    return true
  }
  if (pin.type === 'sha256') {
    const expected = decodeOpenSshSha256Fingerprint(pin.fingerprint)
    if (!expected) {
      return false
    }
    return timingSafeEqual(createHash('sha256').update(key).digest(), Buffer.from(expected))
  }
  if (pin.type === 'public-key') {
    const expected = decodeOpenSshPublicKey(pin.publicKey)
    if (!expected || expected.length !== key.length) {
      return false
    }
    return timingSafeEqual(key, Buffer.from(expected))
  }
  return false
}
