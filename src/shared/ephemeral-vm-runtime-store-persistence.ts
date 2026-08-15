import { existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import {
  writeCriticalSecureJsonFileWithinLimit,
  writeDurableSecureJsonFileWithinLimit
} from './bounded-secure-json-file'
import {
  featureEntryFromRuntime,
  readEphemeralVmRuntimeFeatureStore,
  restoreRuntimeFeatures,
  writeEphemeralVmRuntimeFeatureStore,
  type EphemeralVmRuntimeFeatureStoreSnapshot
} from './ephemeral-vm-runtime-feature-store'
import {
  mergeRuntimeFeatures,
  projectRuntimeForRollback,
  runtimeFeatureListsEqual
} from './ephemeral-vm-runtime-rollback-projection'
import {
  assertUniqueRuntimeIds,
  EphemeralVmRuntimeStoreError,
  isOperatorRuntime
} from './ephemeral-vm-runtime-store-invariants'
import {
  EphemeralVmRuntimeRecordSchema,
  EphemeralVmRuntimeStoreSchema,
  RollbackEphemeralVmRuntimeStoreSchema,
  type EphemeralVmRuntimeStore
} from './ephemeral-vm-runtimes'
import { JsonStringifyByteLimitError } from './node-bounded-json-stringify'
import { readNodeFileSyncWithinLimit } from './node-bounded-file-reader'
import { hardenExistingSecureFile } from './secure-file'
import { readConditionallyAuthoritativeSecureFileSync } from './secure-file-authoritative-read'
import { parseStrictUtf8Json } from './strict-json'

const EPHEMERAL_VM_RUNTIMES_FILE = 'orca-ephemeral-vm-runtimes.json'
export const MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES = 1024 * 1024

export type LoadedEphemeralVmRuntimeStore = {
  store: EphemeralVmRuntimeStore
  features: EphemeralVmRuntimeFeatureStoreSnapshot
}

export function getEphemeralVmRuntimeStorePath(userDataPath: string): string {
  return join(userDataPath, EPHEMERAL_VM_RUNTIMES_FILE)
}

export function readEphemeralVmRuntimeStore(
  userDataPath: string,
  authoritativeOperatorRead = false
): LoadedEphemeralVmRuntimeStore {
  const path = getEphemeralVmRuntimeStorePath(userDataPath)
  try {
    let decoded: ReturnType<typeof parseEphemeralVmRuntimeStore>
    if (authoritativeOperatorRead) {
      try {
        lstatSync(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return emptyEphemeralVmRuntimeStore(userDataPath)
        }
        throw error
      }
      decoded = readConditionallyAuthoritativeSecureFileSync(
        path,
        MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES,
        (buffer) => {
          const value = parseEphemeralVmRuntimeStore(buffer)
          return {
            value,
            requiresCriticalDurability: value.store.runtimes.some(isOperatorRuntime)
          }
        }
      )
    } else {
      if (!existsSync(path)) {
        return emptyEphemeralVmRuntimeStore(userDataPath)
      }
      hardenExistingSecureFile(path)
      decoded = parseEphemeralVmRuntimeStore(
        readNodeFileSyncWithinLimit(path, MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES).buffer
      )
    }
    const features = readEphemeralVmRuntimeFeatureStore(userDataPath)
    const store: EphemeralVmRuntimeStore = {
      version: 1,
      runtimes: decoded.store.runtimes
        .map((entry) => restoreRuntimeFeatures(entry, features.features))
        .sort(compareRuntimeRecords)
    }
    if (
      features.writable &&
      !RollbackEphemeralVmRuntimeStoreSchema.safeParse(decoded.persisted).success
    ) {
      try {
        writeEphemeralVmRuntimeStore(userDataPath, store, features)
      } catch {
        // Why: a failed migration must not block cleanup through the still-readable current shape.
      }
    }
    return { store, features }
  } catch {
    throw new EphemeralVmRuntimeStoreError(
      'runtime_error',
      `Could not read Orca ephemeral VM runtimes at ${path}; the file is invalid.`
    )
  }
}

function emptyEphemeralVmRuntimeStore(userDataPath: string): LoadedEphemeralVmRuntimeStore {
  return {
    store: { version: 1, runtimes: [] },
    features: readEphemeralVmRuntimeFeatureStore(userDataPath)
  }
}

export function writeEphemeralVmRuntimeStore(
  userDataPath: string,
  store: EphemeralVmRuntimeStore,
  features: EphemeralVmRuntimeFeatureStoreSnapshot,
  operatorCritical = store.runtimes.some(isOperatorRuntime)
): void {
  const path = getEphemeralVmRuntimeStorePath(userDataPath)
  try {
    const parsed = EphemeralVmRuntimeStoreSchema.parse(store)
    const requiredFeatures = mergeRuntimeFeatures(
      [],
      parsed.runtimes.flatMap((entry) => {
        const feature = featureEntryFromRuntime(entry)
        return feature ? [feature] : []
      })
    )
    const preparedFeatures = mergeRuntimeFeatures(features.features, requiredFeatures)
    const writeStore = operatorCritical
      ? writeCriticalSecureJsonFileWithinLimit
      : writeDurableSecureJsonFileWithinLimit
    writeStore(
      path,
      RollbackEphemeralVmRuntimeStoreSchema.parse({
        version: 1,
        runtimes: parsed.runtimes.map(projectRuntimeForRollback)
      }),
      MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES
    )
    if (!features.writable && requiredFeatures.length > 0) {
      throw new EphemeralVmRuntimeStoreError(
        'runtime_error',
        'Could not preserve ephemeral VM runtime compatibility metadata.'
      )
    }
    if (features.writable && !runtimeFeatureListsEqual(features.features, preparedFeatures)) {
      writeEphemeralVmRuntimeFeatureStore(userDataPath, features, preparedFeatures)
    }
    if (features.writable && !runtimeFeatureListsEqual(preparedFeatures, requiredFeatures)) {
      try {
        writeEphemeralVmRuntimeFeatureStore(userDataPath, features, requiredFeatures)
      } catch {
        // Stale feature records do not match any persisted runtime identity.
      }
    }
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

function parseEphemeralVmRuntimeStore(buffer: Buffer): {
  persisted: unknown
  store: EphemeralVmRuntimeStore
} {
  const persisted = parseStrictUtf8Json(buffer)
  const parsed = EphemeralVmRuntimeStoreSchema.parse(persisted)
  assertUniqueRuntimeIds(parsed.runtimes)
  return {
    persisted,
    store: {
      version: 1,
      runtimes: parsed.runtimes
        .map((entry) => EphemeralVmRuntimeRecordSchema.parse(entry))
        .sort(compareRuntimeRecords)
    }
  }
}

function compareRuntimeRecords(
  a: EphemeralVmRuntimeStore['runtimes'][number],
  b: EphemeralVmRuntimeStore['runtimes'][number]
): number {
  return b.createdAt - a.createdAt || a.id.localeCompare(b.id)
}
