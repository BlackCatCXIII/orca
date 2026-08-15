import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  EphemeralVmRuntimeStoreError,
  getEphemeralVmRuntimeStorePath,
  listEphemeralVmRuntimes,
  upsertEphemeralVmRuntime
} from '../shared/ephemeral-vm-runtime-store'
import {
  classifyDurableEnvironmentRecipeMutationFromStore,
  EnvironmentRecipeOperationJournalError,
  getEnvironmentRecipeOperationJournalPath,
  prepareDurableEnvironmentRecipeMutation,
  readDurableEnvironmentRecipeMutation,
  retainCapacityForPreparedEnvironmentRecipeMutation,
  type DurableEnvironmentRecipeMutation
} from './environment-recipe-operation-journal'

const roots: string[] = []
const identity = {
  pairedDeviceId: 'paired-device',
  method: 'environmentRecipes.provision',
  clientMutationId: 'mutation-1'
}

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'orca-recipe-operation-journal-'))
  roots.push(path)
  return path
}

function entry(
  clientMutationId: string,
  state: DurableEnvironmentRecipeMutation['state'],
  updatedAt: number
): DurableEnvironmentRecipeMutation {
  return {
    ...identity,
    clientMutationId,
    fingerprint: 'f'.repeat(64),
    provisionRef: 'a'.repeat(40),
    runtimeId: `runtime-${clientMutationId}`,
    operatorRecipeCatalogSha256: 'c'.repeat(64),
    state,
    createdAt: updatedAt,
    updatedAt
  }
}

function prepareInput(candidate: DurableEnvironmentRecipeMutation) {
  const { state: _state, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = candidate
  return input
}

function corruptPersistedJsonField(path: string, value: string): void {
  const bytes = readFileSync(path)
  const offset = bytes.indexOf(value)
  if (offset === -1) {
    throw new Error(`Persisted field not found: ${value}`)
  }
  bytes[offset] = 0xc3
  bytes[offset + 1] = 0x28
  writeFileSync(path, bytes)
}

function persistRuntime(
  userDataPath: string,
  mutation: DurableEnvironmentRecipeMutation,
  status: 'running' | 'cleaned'
): void {
  upsertEphemeralVmRuntime(userDataPath, {
    id: mutation.runtimeId,
    recipeId: 'operator-box',
    operatorRecipeCatalogSha256: mutation.operatorRecipeCatalogSha256,
    provisionMutation: {
      requestSha256: mutation.fingerprint,
      resolvedRef: mutation.provisionRef
    },
    status,
    cleanupStatus: status === 'cleaned' ? 'succeeded' : 'not_started',
    createdAt: mutation.createdAt,
    updatedAt: mutation.updatedAt,
    recipeResult: {
      schemaVersion: 2,
      checkoutMode: 'provisioned-root',
      connection: {
        type: 'ssh',
        projectRoot: '/srv/repo',
        target: {
          label: 'host',
          host: 'host',
          port: 22,
          username: 'orca',
          hostKey: { type: 'sha256', fingerprint: `SHA256:${'A'.repeat(43)}` }
        }
      }
    }
  })
}

function persistCleanedRuntime(
  userDataPath: string,
  mutation: DurableEnvironmentRecipeMutation
): void {
  persistRuntime(userDataPath, mutation, 'cleaned')
}

describe('environment recipe operation journal', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    for (const path of roots.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  it('keeps prepared identity bytes and derives completed or terminal state from runtime backing', () => {
    const userDataPath = root()
    const completed = entry('mutation-1', 'prepared', 1)
    prepareDurableEnvironmentRecipeMutation(userDataPath, {
      ...identity,
      ...prepareInput(completed)
    })
    expect(readDurableEnvironmentRecipeMutation(userDataPath, identity)?.state).toBe('prepared')
    persistRuntime(userDataPath, completed, 'running')
    expect(classifyDurableEnvironmentRecipeMutationFromStore(userDataPath, completed)).toBe(
      'completed'
    )
    expect(readDurableEnvironmentRecipeMutation(userDataPath, identity)?.state).toBe('prepared')

    const terminal = entry('mutation-terminal', 'prepared', 2)
    prepareDurableEnvironmentRecipeMutation(userDataPath, prepareInput(terminal))
    persistRuntime(userDataPath, terminal, 'cleaned')
    expect(classifyDurableEnvironmentRecipeMutationFromStore(userDataPath, terminal)).toBe(
      'terminal'
    )
    expect(readDurableEnvironmentRecipeMutation(userDataPath, terminal)?.state).toBe('prepared')
  })

  it('reads legacy completed and terminal entries without rewriting them', () => {
    const userDataPath = root()
    const completed = entry('legacy-completed', 'completed', 1)
    const terminal = entry('legacy-terminal', 'terminal', 2)
    persistRuntime(userDataPath, completed, 'running')
    writeFileSync(
      getEnvironmentRecipeOperationJournalPath(userDataPath),
      JSON.stringify({ version: 1, entries: [completed, terminal] }),
      'utf8'
    )

    expect(classifyDurableEnvironmentRecipeMutationFromStore(userDataPath, completed)).toBe(
      'completed'
    )
    expect(classifyDurableEnvironmentRecipeMutationFromStore(userDataPath, terminal)).toBe(
      'terminal'
    )
  })

  it('does not evict a legacy terminal entry without an exact runtime tombstone', () => {
    const userDataPath = root()
    const terminal = entry('legacy-terminal-without-tombstone', 'terminal', 1)
    writeFileSync(
      getEnvironmentRecipeOperationJournalPath(userDataPath),
      JSON.stringify({ version: 1, entries: [terminal] }),
      'utf8'
    )

    expect(() =>
      prepareDurableEnvironmentRecipeMutation(
        userDataPath,
        prepareInput(entry('next-attempt', 'prepared', 2)),
        2,
        1
      )
    ).toThrow(expect.objectContaining({ code: 'capacity' }))
    expect(readDurableEnvironmentRecipeMutation(userDataPath, terminal)).toEqual(terminal)
  })

  it('evicts the oldest backed terminal entry and fails closed with uncertain capacity', () => {
    const completed = entry('terminal-oldest', 'terminal', 1)
    const newerCompleted = entry('completed-newer', 'completed', 2)
    const prepared = entry('prepared', 'prepared', 3)

    expect(
      retainCapacityForPreparedEnvironmentRecipeMutation(
        [completed, newerCompleted, prepared],
        3,
        (candidate) => candidate.state !== 'prepared'
      )
    ).toEqual([newerCompleted, prepared])
    expect(() =>
      retainCapacityForPreparedEnvironmentRecipeMutation(
        [entry('prepared-1', 'prepared', 1), entry('terminal', 'terminal', 2)],
        2
      )
    ).toThrow(EnvironmentRecipeOperationJournalError)
  })

  it('retains more terminal attempts than journal capacity through cleaned runtime bindings', () => {
    const userDataPath = root()
    const first = entry('terminal-first', 'terminal', 1)
    const second = entry('terminal-second', 'terminal', 2)
    const third = entry('terminal-third', 'prepared', 3)

    prepareDurableEnvironmentRecipeMutation(userDataPath, prepareInput(first), 1, 2)
    persistCleanedRuntime(userDataPath, first)
    prepareDurableEnvironmentRecipeMutation(userDataPath, prepareInput(second), 2, 2)
    persistCleanedRuntime(userDataPath, second)
    prepareDurableEnvironmentRecipeMutation(userDataPath, prepareInput(third), 3, 2)

    expect(readDurableEnvironmentRecipeMutation(userDataPath, first)).toBeNull()
    expect(readDurableEnvironmentRecipeMutation(userDataPath, second)?.state).toBe('prepared')
    expect(readDurableEnvironmentRecipeMutation(userDataPath, third)?.state).toBe('prepared')
  })

  it('rejects malformed UTF-8 in a persisted mutation identity', () => {
    const userDataPath = root()
    const prepared = entry('invalid-utf8', 'prepared', 1)
    prepareDurableEnvironmentRecipeMutation(userDataPath, prepareInput(prepared), 1)
    corruptPersistedJsonField(
      getEnvironmentRecipeOperationJournalPath(userDataPath),
      prepared.pairedDeviceId
    )

    expect(() => readDurableEnvironmentRecipeMutation(userDataPath, prepared)).toThrow(
      EnvironmentRecipeOperationJournalError
    )
  })

  it('rejects duplicate JSON keys in a persisted mutation identity', () => {
    const userDataPath = root()
    const prepared = entry('duplicate-key', 'prepared', 1)
    prepareDurableEnvironmentRecipeMutation(userDataPath, prepareInput(prepared), 1)
    const path = getEnvironmentRecipeOperationJournalPath(userDataPath)
    const source = readFileSync(path, 'utf8').replace(
      '"pairedDeviceId":"paired-device"',
      '"pairedDeviceId":"paired-device","pairedDeviceId":"paired-device"'
    )
    writeFileSync(path, source, 'utf8')

    expect(() => readDurableEnvironmentRecipeMutation(userDataPath, prepared)).toThrow(
      EnvironmentRecipeOperationJournalError
    )
  })

  it('rejects duplicate logical mutation identities', () => {
    const userDataPath = root()
    const duplicate = entry('duplicate-identity', 'completed', 1)
    writeFileSync(
      getEnvironmentRecipeOperationJournalPath(userDataPath),
      JSON.stringify({ version: 1, entries: [duplicate, { ...duplicate, updatedAt: 2 }] }),
      'utf8'
    )

    expect(() => readDurableEnvironmentRecipeMutation(userDataPath, duplicate)).toThrow(
      EnvironmentRecipeOperationJournalError
    )
  })

  it('fails closed when evicted mutation backing records contain duplicate runtime IDs', () => {
    const userDataPath = root()
    const first = entry('evicted-corrupt-runtime', 'terminal', 1)
    const second = entry('retained-terminal', 'terminal', 2)
    const third = entry('retained-prepared', 'prepared', 3)

    prepareDurableEnvironmentRecipeMutation(userDataPath, prepareInput(first), 1, 2)
    persistCleanedRuntime(userDataPath, first)
    prepareDurableEnvironmentRecipeMutation(userDataPath, prepareInput(second), 2, 2)
    persistCleanedRuntime(userDataPath, second)
    prepareDurableEnvironmentRecipeMutation(userDataPath, prepareInput(third), 3, 2)
    expect(readDurableEnvironmentRecipeMutation(userDataPath, first)).toBeNull()

    const runtimeStorePath = getEphemeralVmRuntimeStorePath(userDataPath)
    const runtimes = listEphemeralVmRuntimes(userDataPath)
    const duplicatedRuntime = runtimes.find((runtime) => runtime.id === first.runtimeId)
    if (!duplicatedRuntime) {
      throw new Error('Evicted mutation runtime backing record not found.')
    }
    writeFileSync(
      runtimeStorePath,
      JSON.stringify({ version: 1, runtimes: [...runtimes, duplicatedRuntime] }),
      'utf8'
    )

    expect(() =>
      prepareDurableEnvironmentRecipeMutation(userDataPath, prepareInput(first), 4, 2)
    ).toThrow(EphemeralVmRuntimeStoreError)
    expect(readDurableEnvironmentRecipeMutation(userDataPath, first)).toBeNull()
    expect(readDurableEnvironmentRecipeMutation(userDataPath, second)).not.toBeNull()
    expect(readDurableEnvironmentRecipeMutation(userDataPath, third)).not.toBeNull()
  })

  it('serializes same-process read-modify-write preparation for different mutations', async () => {
    const userDataPath = root()
    const first = entry('concurrent-first', 'prepared', 1)
    const second = entry('concurrent-second', 'prepared', 2)

    await Promise.all([
      Promise.resolve().then(() =>
        prepareDurableEnvironmentRecipeMutation(userDataPath, prepareInput(first), 1)
      ),
      Promise.resolve().then(() =>
        prepareDurableEnvironmentRecipeMutation(userDataPath, prepareInput(second), 2)
      )
    ])

    expect(readDurableEnvironmentRecipeMutation(userDataPath, first)?.provisionRef).toBe(
      first.provisionRef
    )
    expect(readDurableEnvironmentRecipeMutation(userDataPath, second)?.provisionRef).toBe(
      second.provisionRef
    )
  })
})
