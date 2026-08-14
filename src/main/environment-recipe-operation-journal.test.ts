import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { upsertEphemeralVmRuntime } from '../shared/ephemeral-vm-runtime-store'
import {
  completeDurableEnvironmentRecipeMutation,
  EnvironmentRecipeOperationJournalError,
  prepareDurableEnvironmentRecipeMutation,
  readDurableEnvironmentRecipeMutation,
  retainCapacityForPreparedEnvironmentRecipeMutation,
  terminateDurableEnvironmentRecipeMutation,
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

function persistCleanedRuntime(
  userDataPath: string,
  mutation: DurableEnvironmentRecipeMutation
): void {
  upsertEphemeralVmRuntime(userDataPath, {
    id: mutation.runtimeId,
    recipeId: 'operator-box',
    operatorRecipeCatalogSha256: mutation.operatorRecipeCatalogSha256,
    provisionMutation: {
      requestSha256: mutation.fingerprint,
      resolvedRef: mutation.provisionRef
    },
    status: 'cleaned',
    cleanupStatus: 'succeeded',
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

  it('durably transitions prepared mutations to completed or terminal states', () => {
    const userDataPath = root()
    prepareDurableEnvironmentRecipeMutation(userDataPath, {
      ...identity,
      fingerprint: 'f'.repeat(64),
      provisionRef: 'a'.repeat(40),
      runtimeId: 'runtime-1',
      operatorRecipeCatalogSha256: 'c'.repeat(64)
    })
    expect(readDurableEnvironmentRecipeMutation(userDataPath, identity)?.state).toBe('prepared')

    completeDurableEnvironmentRecipeMutation(userDataPath, identity)
    expect(readDurableEnvironmentRecipeMutation(userDataPath, identity)?.state).toBe('completed')

    const terminalIdentity = { ...identity, clientMutationId: 'mutation-terminal' }
    prepareDurableEnvironmentRecipeMutation(userDataPath, {
      ...terminalIdentity,
      fingerprint: 'e'.repeat(64),
      provisionRef: 'b'.repeat(40),
      runtimeId: 'runtime-terminal',
      operatorRecipeCatalogSha256: 'c'.repeat(64)
    })
    terminateDurableEnvironmentRecipeMutation(userDataPath, terminalIdentity)
    expect(readDurableEnvironmentRecipeMutation(userDataPath, terminalIdentity)?.state).toBe(
      'terminal'
    )
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
    terminateDurableEnvironmentRecipeMutation(userDataPath, first, 1)
    prepareDurableEnvironmentRecipeMutation(userDataPath, prepareInput(second), 2, 2)
    persistCleanedRuntime(userDataPath, second)
    terminateDurableEnvironmentRecipeMutation(userDataPath, second, 2)
    prepareDurableEnvironmentRecipeMutation(userDataPath, prepareInput(third), 3, 2)

    expect(readDurableEnvironmentRecipeMutation(userDataPath, first)).toBeNull()
    expect(readDurableEnvironmentRecipeMutation(userDataPath, second)?.state).toBe('terminal')
    expect(readDurableEnvironmentRecipeMutation(userDataPath, third)?.state).toBe('prepared')
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
