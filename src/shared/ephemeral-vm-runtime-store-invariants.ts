import type { EphemeralVmRuntimeRecord } from './ephemeral-vm-runtimes'

export type EphemeralVmRuntimeStoreErrorCode = 'invalid_argument' | 'runtime_error'

export class EphemeralVmRuntimeStoreError extends Error {
  readonly code: EphemeralVmRuntimeStoreErrorCode

  constructor(code: EphemeralVmRuntimeStoreErrorCode, message: string) {
    super(message)
    this.name = 'EphemeralVmRuntimeStoreError'
    this.code = code
  }
}

export function assertOperatorRuntimeBindingPreserved(
  existing: EphemeralVmRuntimeRecord | undefined,
  next: EphemeralVmRuntimeRecord
): void {
  if (!existing?.operatorRecipeCatalogSha256) {
    return
  }
  if (
    next.operatorRecipeCatalogSha256 !== existing.operatorRecipeCatalogSha256 ||
    next.provisionMutation?.requestSha256 !== existing.provisionMutation?.requestSha256 ||
    next.provisionMutation?.resolvedRef !== existing.provisionMutation?.resolvedRef
  ) {
    throw new EphemeralVmRuntimeStoreError(
      'invalid_argument',
      `Operator runtime binding cannot change: ${existing.id}`
    )
  }
}

export function assertUniqueRuntimeIds(runtimes: EphemeralVmRuntimeRecord[]): void {
  const runtimeIds = new Set<string>()
  for (const runtime of runtimes) {
    if (runtimeIds.has(runtime.id)) {
      throw new Error('Duplicate ephemeral VM runtime ID.')
    }
    runtimeIds.add(runtime.id)
  }
}

export function isOperatorRuntime(runtime: EphemeralVmRuntimeRecord): boolean {
  return runtime.operatorRecipeCatalogSha256 !== undefined
}
