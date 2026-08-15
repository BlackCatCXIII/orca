import {
  writeCriticalSecureJsonFileWithinLimit,
  writeDurableSecureJsonFileWithinLimit
} from './bounded-secure-json-file'
import { featureIdentity, runtimeFeaturesEqual } from './ephemeral-vm-runtime-feature-store'
import { projectRuntimeForRollback } from './ephemeral-vm-runtime-rollback-projection'
import {
  getEphemeralVmRuntimeStorePath,
  MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES,
  readEphemeralVmRuntimeStore,
  writeEphemeralVmRuntimeStore
} from './ephemeral-vm-runtime-store-persistence'
import {
  EphemeralVmRuntimeRecordSchema,
  RollbackEphemeralVmRuntimeStoreSchema,
  type EphemeralVmCleanupStatus,
  type EphemeralVmRuntimeRecord,
  type EphemeralVmRuntimeStatus
} from './ephemeral-vm-runtimes'
import { JsonStringifyByteLimitError } from './node-bounded-json-stringify'
import {
  assertOperatorRuntimeBindingPreserved,
  EphemeralVmRuntimeStoreError,
  isOperatorRuntime
} from './ephemeral-vm-runtime-store-invariants'

export { EphemeralVmRuntimeStoreError } from './ephemeral-vm-runtime-store-invariants'
export type { EphemeralVmRuntimeStoreErrorCode } from './ephemeral-vm-runtime-store-invariants'

export {
  getEphemeralVmRuntimeStorePath,
  MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES
} from './ephemeral-vm-runtime-store-persistence'

export function listEphemeralVmRuntimes(userDataPath: string): EphemeralVmRuntimeRecord[] {
  return readEphemeralVmRuntimeStore(userDataPath).store.runtimes
}

export function listAuthoritativeEphemeralVmRuntimes(
  userDataPath: string
): EphemeralVmRuntimeRecord[] {
  return readEphemeralVmRuntimeStore(userDataPath, true).store.runtimes
}

export function upsertEphemeralVmRuntime(
  userDataPath: string,
  record: EphemeralVmRuntimeRecord
): EphemeralVmRuntimeRecord {
  const parsed = EphemeralVmRuntimeRecordSchema.parse(record)
  const loaded = readEphemeralVmRuntimeStore(userDataPath)
  const previous = loaded.store.runtimes.find((entry) => entry.id === parsed.id)
  if (
    previous &&
    featureIdentity(previous) === featureIdentity(parsed) &&
    !runtimeFeaturesEqual(previous, parsed)
  ) {
    throw new EphemeralVmRuntimeStoreError(
      'invalid_argument',
      `Cannot change compatibility features for ephemeral VM runtime: ${parsed.id}`
    )
  }
  assertOperatorRuntimeBindingPreserved(previous, parsed)
  writeEphemeralVmRuntimeStore(
    userDataPath,
    {
      version: 1,
      runtimes: [...loaded.store.runtimes.filter((entry) => entry.id !== parsed.id), parsed].sort(
        compareRuntimeRecords
      )
    },
    loaded.features,
    isOperatorRuntime(parsed) || loaded.store.runtimes.some(isOperatorRuntime)
  )
  return parsed
}

export function upsertEphemeralVmRuntimeRollbackRecovery(
  userDataPath: string,
  record: EphemeralVmRuntimeRecord
): void {
  const parsed = EphemeralVmRuntimeRecordSchema.parse(record)
  const loaded = readEphemeralVmRuntimeStore(userDataPath)
  const existing = loaded.store.runtimes.find((entry) => entry.id === parsed.id)
  assertOperatorRuntimeBindingPreserved(existing, parsed)
  const path = getEphemeralVmRuntimeStorePath(userDataPath)
  try {
    const writeStore =
      isOperatorRuntime(parsed) || loaded.store.runtimes.some(isOperatorRuntime)
        ? writeCriticalSecureJsonFileWithinLimit
        : writeDurableSecureJsonFileWithinLimit
    writeStore(
      path,
      RollbackEphemeralVmRuntimeStoreSchema.parse({
        version: 1,
        runtimes: [...loaded.store.runtimes.filter((entry) => entry.id !== parsed.id), parsed]
          .sort(compareRuntimeRecords)
          .map(projectRuntimeForRollback)
      }),
      MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES
    )
  } catch (error) {
    if (error instanceof JsonStringifyByteLimitError) {
      throw new EphemeralVmRuntimeStoreError(
        'runtime_error',
        `Could not write Orca ephemeral VM runtimes at ${path}; the store exceeds its durable capacity.`
      )
    }
    throw error
  }
}

export function updateEphemeralVmRuntimeStatus(
  userDataPath: string,
  id: string,
  args: {
    status?: EphemeralVmRuntimeStatus
    cleanupStatus?: EphemeralVmCleanupStatus
    cleanupLastAttemptAt?: number
    cleanupLastError?: string | null
    workspaceId?: string
    workspaceName?: string
    connectionMode?: EphemeralVmRuntimeRecord['connectionMode'] | null
    runtimeEnvironmentId?: string
    sshTargetId?: string | null
    recipeResult?: EphemeralVmRuntimeRecord['recipeResult']
    updatedAt?: number
  }
): EphemeralVmRuntimeRecord {
  const loaded = readEphemeralVmRuntimeStore(userDataPath)
  const existing = loaded.store.runtimes.find((entry) => entry.id === id)
  if (!existing) {
    throw new EphemeralVmRuntimeStoreError(
      'invalid_argument',
      `Unknown ephemeral VM runtime: ${id}`
    )
  }
  const next = EphemeralVmRuntimeRecordSchema.parse({
    ...existing,
    ...(args.status ? { status: args.status } : {}),
    ...(args.cleanupStatus ? { cleanupStatus: args.cleanupStatus } : {}),
    ...(args.cleanupLastAttemptAt !== undefined
      ? { cleanupLastAttemptAt: args.cleanupLastAttemptAt }
      : {}),
    ...(args.cleanupLastError === null
      ? { cleanupLastError: undefined }
      : args.cleanupLastError
        ? { cleanupLastError: args.cleanupLastError }
        : {}),
    ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
    ...(args.workspaceName ? { workspaceName: args.workspaceName } : {}),
    // null explicitly clears the field (e.g. terminal cleanup); undefined leaves it unchanged.
    ...(args.connectionMode === null
      ? { connectionMode: undefined }
      : args.connectionMode
        ? { connectionMode: args.connectionMode }
        : {}),
    ...(args.runtimeEnvironmentId ? { runtimeEnvironmentId: args.runtimeEnvironmentId } : {}),
    ...(args.sshTargetId === null
      ? { sshTargetId: undefined }
      : args.sshTargetId
        ? { sshTargetId: args.sshTargetId }
        : {}),
    ...(args.recipeResult ? { recipeResult: args.recipeResult } : {}),
    updatedAt: args.updatedAt ?? Date.now()
  })
  writeEphemeralVmRuntimeStore(
    userDataPath,
    {
      version: 1,
      runtimes: loaded.store.runtimes
        .map((entry) => (entry.id === id ? next : entry))
        .sort(compareRuntimeRecords)
    },
    loaded.features,
    loaded.store.runtimes.some(isOperatorRuntime)
  )
  return next
}

export function removeEphemeralVmRuntime(
  userDataPath: string,
  id: string
): EphemeralVmRuntimeRecord {
  const loaded = readEphemeralVmRuntimeStore(userDataPath)
  const existing = loaded.store.runtimes.find((entry) => entry.id === id)
  if (!existing) {
    throw new EphemeralVmRuntimeStoreError(
      'invalid_argument',
      `Unknown ephemeral VM runtime: ${id}`
    )
  }
  writeEphemeralVmRuntimeStore(
    userDataPath,
    {
      version: 1,
      runtimes: loaded.store.runtimes.filter((entry) => entry.id !== id)
    },
    loaded.features,
    loaded.store.runtimes.some(isOperatorRuntime)
  )
  return existing
}

function compareRuntimeRecords(a: EphemeralVmRuntimeRecord, b: EphemeralVmRuntimeRecord): number {
  return b.createdAt - a.createdAt || a.id.localeCompare(b.id)
}
