import { existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { JsonStringifyByteLimitError } from './node-bounded-json-stringify'
import { readNodeFileSyncWithinLimit } from './node-bounded-file-reader'
import {
  writeCriticalSecureJsonFileWithinLimit,
  writeDurableSecureJsonFileWithinLimit
} from './bounded-secure-json-file'
import { hardenExistingSecureFile } from './secure-file'
import { readConditionallyAuthoritativeSecureFileSync } from './secure-file-authoritative-read'
import { parseStrictUtf8Json } from './strict-json'
import {
  EphemeralVmRuntimeRecordSchema,
  EphemeralVmRuntimeStoreSchema,
  type EphemeralVmCleanupStatus,
  type EphemeralVmRuntimeRecord,
  type EphemeralVmRuntimeStatus,
  type EphemeralVmRuntimeStore
} from './ephemeral-vm-runtimes'

const EPHEMERAL_VM_RUNTIMES_FILE = 'orca-ephemeral-vm-runtimes.json'
export const MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES = 1024 * 1024

export type EphemeralVmRuntimeStoreErrorCode = 'invalid_argument' | 'runtime_error'

export class EphemeralVmRuntimeStoreError extends Error {
  readonly code: EphemeralVmRuntimeStoreErrorCode

  constructor(code: EphemeralVmRuntimeStoreErrorCode, message: string) {
    super(message)
    this.name = 'EphemeralVmRuntimeStoreError'
    this.code = code
  }
}

export function getEphemeralVmRuntimeStorePath(userDataPath: string): string {
  return join(userDataPath, EPHEMERAL_VM_RUNTIMES_FILE)
}

export function listEphemeralVmRuntimes(userDataPath: string): EphemeralVmRuntimeRecord[] {
  return readEphemeralVmRuntimeStore(userDataPath).runtimes
}

export function listAuthoritativeEphemeralVmRuntimes(
  userDataPath: string
): EphemeralVmRuntimeRecord[] {
  return readEphemeralVmRuntimeStore(userDataPath, true).runtimes
}

export function upsertEphemeralVmRuntime(
  userDataPath: string,
  record: EphemeralVmRuntimeRecord
): EphemeralVmRuntimeRecord {
  const parsed = EphemeralVmRuntimeRecordSchema.parse(record)
  const store = readEphemeralVmRuntimeStore(userDataPath)
  const existing = store.runtimes.find((entry) => entry.id === parsed.id)
  assertOperatorRuntimeBindingPreserved(existing, parsed)
  writeEphemeralVmRuntimeStore(
    userDataPath,
    {
      version: 1,
      runtimes: [...store.runtimes.filter((entry) => entry.id !== parsed.id), parsed].sort(
        compareRuntimeRecords
      )
    },
    isOperatorRuntime(parsed) || store.runtimes.some(isOperatorRuntime)
  )
  return parsed
}

function assertOperatorRuntimeBindingPreserved(
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
  const store = readEphemeralVmRuntimeStore(userDataPath)
  const existing = store.runtimes.find((entry) => entry.id === id)
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
      runtimes: store.runtimes
        .map((entry) => (entry.id === id ? next : entry))
        .sort(compareRuntimeRecords)
    },
    store.runtimes.some(isOperatorRuntime)
  )
  return next
}

export function removeEphemeralVmRuntime(
  userDataPath: string,
  id: string
): EphemeralVmRuntimeRecord {
  const store = readEphemeralVmRuntimeStore(userDataPath)
  const existing = store.runtimes.find((entry) => entry.id === id)
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
      runtimes: store.runtimes.filter((entry) => entry.id !== id)
    },
    store.runtimes.some(isOperatorRuntime)
  )
  return existing
}

function readEphemeralVmRuntimeStore(
  userDataPath: string,
  authoritativeOperatorRead = false
): EphemeralVmRuntimeStore {
  const path = getEphemeralVmRuntimeStorePath(userDataPath)
  try {
    if (authoritativeOperatorRead) {
      try {
        lstatSync(path)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          return { version: 1, runtimes: [] }
        }
        throw error
      }
      return readConditionallyAuthoritativeSecureFileSync(
        path,
        MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES,
        (buffer) => {
          const value = parseEphemeralVmRuntimeStore(buffer)
          return {
            value,
            requiresCriticalDurability: value.runtimes.some(isOperatorRuntime)
          }
        }
      )
    }
    if (!existsSync(path)) {
      return { version: 1, runtimes: [] }
    }
    hardenExistingSecureFile(path)
    return parseEphemeralVmRuntimeStore(
      readNodeFileSyncWithinLimit(path, MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES).buffer
    )
  } catch {
    throw new EphemeralVmRuntimeStoreError(
      'runtime_error',
      `Could not read Orca ephemeral VM runtimes at ${path}; the file is invalid.`
    )
  }
}

function parseEphemeralVmRuntimeStore(buffer: Buffer): EphemeralVmRuntimeStore {
  const parsed = EphemeralVmRuntimeStoreSchema.parse(parseStrictUtf8Json(buffer))
  assertUniqueRuntimeIds(parsed.runtimes)
  return {
    version: 1,
    runtimes: parsed.runtimes
      .map((entry) => EphemeralVmRuntimeRecordSchema.parse(entry))
      .sort(compareRuntimeRecords)
  }
}

function assertUniqueRuntimeIds(runtimes: EphemeralVmRuntimeRecord[]): void {
  const runtimeIds = new Set<string>()
  for (const runtime of runtimes) {
    if (runtimeIds.has(runtime.id)) {
      throw new Error('Duplicate ephemeral VM runtime ID.')
    }
    runtimeIds.add(runtime.id)
  }
}

function writeEphemeralVmRuntimeStore(
  userDataPath: string,
  store: EphemeralVmRuntimeStore,
  operatorCritical: boolean
): void {
  const path = getEphemeralVmRuntimeStorePath(userDataPath)
  try {
    const writeStore = operatorCritical
      ? writeCriticalSecureJsonFileWithinLimit
      : writeDurableSecureJsonFileWithinLimit
    writeStore(
      path,
      EphemeralVmRuntimeStoreSchema.parse(store),
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

function isOperatorRuntime(runtime: EphemeralVmRuntimeRecord): boolean {
  return runtime.operatorRecipeCatalogSha256 !== undefined
}

function compareRuntimeRecords(a: EphemeralVmRuntimeRecord, b: EphemeralVmRuntimeRecord): number {
  return b.createdAt - a.createdAt || a.id.localeCompare(b.id)
}
