import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const MUTATION_FINGERPRINT_DOMAIN = 'orca-environment-recipe-mutation-v1\0'

export function environmentRecipeMutationRequestSha256(params: object): string {
  return createHash('sha256')
    .update(MUTATION_FINGERPRINT_DOMAIN)
    .update(canonicalEnvironmentRecipeMutationJson(params))
    .digest('hex')
}

export function canonicalEnvironmentRecipeMutationJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value
      .map((entry) => canonicalEnvironmentRecipeMutationJson(entry ?? null))
      .join(',')}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries
      .map(
        ([key, entry]) => `${JSON.stringify(key)}:${canonicalEnvironmentRecipeMutationJson(entry)}`
      )
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function environmentRecipeMutationRuntimeId(
  profilePath: string,
  pairedDeviceId: string,
  clientMutationId: string
): string {
  const digest = createHash('sha256')
    .update(normalizeEnvironmentRecipeProfilePath(profilePath))
    .update('\0')
    .update(pairedDeviceId)
    .update('\0')
    .update(clientMutationId)
    .digest('hex')
    .slice(0, 32)
  return `remote-recipe-${digest}`
}

export function normalizeEnvironmentRecipeProfilePath(profilePath: string): string {
  const normalized = resolve(profilePath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
