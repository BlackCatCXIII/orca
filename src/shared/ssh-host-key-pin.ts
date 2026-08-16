export type SshHostKeyPin =
  | { type: 'sha256'; fingerprint: string }
  | { type: 'public-key'; publicKey: string }

const OPENSSH_SHA256_PREFIX = 'SHA256:'
const OPENSSH_PUBLIC_KEY_PATTERN = /^([^\s]{1,128}) ([A-Za-z0-9+/]+={0,2})$/
const SSH_KEY_ALGORITHM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$/

export function decodeOpenSshSha256Fingerprint(value: string): Uint8Array | null {
  if (!value.startsWith(OPENSSH_SHA256_PREFIX)) {
    return null
  }
  const encoded = value.slice(OPENSSH_SHA256_PREFIX.length)
  if (encoded.length !== 43 || !/^[A-Za-z0-9+/]+$/.test(encoded)) {
    return null
  }
  const decoded = decodeBase64(encoded)
  return decoded?.length === 32 ? decoded : null
}

export function decodeOpenSshPublicKey(value: string): Uint8Array | null {
  const match = OPENSSH_PUBLIC_KEY_PATTERN.exec(value)
  if (!match) {
    return null
  }
  const [, declaredAlgorithm = '', encoded = ''] = match
  if (!SSH_KEY_ALGORITHM_PATTERN.test(declaredAlgorithm)) {
    return null
  }
  const decoded = decodeBase64(encoded)
  if (!decoded || readSshKeyAlgorithm(decoded) !== declaredAlgorithm) {
    return null
  }
  return decoded
}

function decodeBase64(value: string): Uint8Array | null {
  if (value.length === 0 || value.length > 16_384 || value.length % 4 === 1) {
    return null
  }
  try {
    const padded = value.padEnd(Math.ceil(value.length / 4) * 4, '=')
    const decoded = atob(padded)
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0))
    const canonical = btoa(String.fromCharCode(...bytes))
    return value === canonical || value === canonical.replace(/=+$/, '') ? bytes : null
  } catch {
    return null
  }
}

function readSshKeyAlgorithm(key: Uint8Array): string | null {
  if (key.length < 4) {
    return null
  }
  const length =
    ((key[0] ?? 0) * 0x1000000 +
      (key[1] ?? 0) * 0x10000 +
      (key[2] ?? 0) * 0x100 +
      (key[3] ?? 0)) >>>
    0
  if (length === 0 || length > 128 || key.length < 4 + length) {
    return null
  }
  const algorithmBytes = key.subarray(4, 4 + length)
  if (algorithmBytes.some((byte) => byte < 0x21 || byte > 0x7e)) {
    return null
  }
  return String.fromCharCode(...algorithmBytes)
}
