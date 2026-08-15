import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as SecureFileModule from '../shared/secure-file'

const secureWrites = vi.hoisted(
  () => [] as { targetPath: string; durability: 'best-effort' | 'critical' | 'none' }[]
)

vi.mock('../shared/secure-file', async (importOriginal) => {
  const actual = await importOriginal<typeof SecureFileModule>()
  return {
    ...actual,
    writeSecureFile(
      targetPath: string,
      contents: string,
      options: { durable?: boolean; durability?: 'critical' } = {}
    ): void {
      actual.writeSecureFile(targetPath, contents, options)
      secureWrites.push({
        targetPath,
        durability: options.durability ?? (options.durable ? 'best-effort' : 'none')
      })
    }
  }
})

import {
  getEphemeralVmRuntimeStorePath,
  upsertEphemeralVmRuntime
} from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeStatus } from '../shared/ephemeral-vm-runtimes'
import type { EnvironmentRecipeRuntime } from '../shared/environment-recipe-runtime-rpc'
import {
  __setCriticalSecureFileTestHooksForTests,
  type CriticalSecureFileStage
} from '../shared/secure-file'
import {
  resetEnvironmentRecipeOperationControlForTests,
  runIdempotentEnvironmentRecipeMutation
} from './environment-recipe-operation-control'
import {
  getEnvironmentRecipeOperationJournalPath,
  prepareDurableEnvironmentRecipeMutation,
  readDurableEnvironmentRecipeMutation
} from './environment-recipe-operation-journal'

const roots: string[] = []
const posixIt = process.platform === 'win32' ? it.skip : it
const operatorRecipeCatalogSha256 = 'c'.repeat(64)
const provisionRef = 'a'.repeat(40)

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'orca-recipe-operation-durability-'))
  roots.push(path)
  return path
}

function persistRuntimeBacking(
  userDataPath: string,
  runtimeId: string,
  requestSha256: string,
  status: EphemeralVmRuntimeStatus
): void {
  upsertEphemeralVmRuntime(userDataPath, {
    id: runtimeId,
    repoId: 'repo-1',
    recipeId: 'operator-box',
    operatorRecipeCatalogSha256,
    provisionMutation: { requestSha256, resolvedRef: provisionRef },
    status,
    cleanupStatus:
      status === 'cleaned' ? 'succeeded' : status === 'cleanup_failed' ? 'failed' : 'not_started',
    createdAt: 1,
    updatedAt: 1,
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

function result(
  runtimeId: string,
  status: EnvironmentRecipeRuntime['status']
): EnvironmentRecipeRuntime {
  return {
    runtimeId,
    repoId: 'repo-1',
    recipeId: 'operator-box',
    checkoutMode: 'provisioned-root',
    status,
    lifecycle: { suspend: false, resume: false, destroy: true },
    createdAt: 1,
    updatedAt: 1,
    connectionType: 'ssh',
    projectRoot: '/srv/repo'
  }
}

function evictBackedMutation(userDataPath: string, clientMutationId: string): void {
  prepareDurableEnvironmentRecipeMutation(
    userDataPath,
    {
      pairedDeviceId: 'paired-device',
      method: 'environmentRecipes.provision',
      clientMutationId: `${clientMutationId}-next`,
      fingerprint: 'e'.repeat(64),
      provisionRef: 'b'.repeat(40),
      runtimeId: `${clientMutationId}-next-runtime`,
      operatorRecipeCatalogSha256
    },
    2,
    1
  )
}

function expectDurableWriteOrder(userDataPath: string): void {
  expect(secureWrites).toEqual([
    {
      targetPath: getEnvironmentRecipeOperationJournalPath(userDataPath),
      durability: 'critical'
    },
    {
      targetPath: getEphemeralVmRuntimeStorePath(userDataPath),
      durability: 'critical'
    },
    {
      targetPath: getEnvironmentRecipeOperationJournalPath(userDataPath),
      durability: 'critical'
    },
    {
      targetPath: getEnvironmentRecipeOperationJournalPath(userDataPath),
      durability: 'critical'
    }
  ])
}

afterEach(() => {
  resetEnvironmentRecipeOperationControlForTests()
  __setCriticalSecureFileTestHooksForTests(null)
  secureWrites.length = 0
  for (const path of roots.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

const failureStages: CriticalSecureFileStage[] = ['temp-fsync', 'rename', 'parent-dir-fsync']
const backedStatuses: EphemeralVmRuntimeStatus[] = ['running', 'cleaned', 'cleanup_failed']

describe('environment recipe operation durability ordering', () => {
  it('does not require critical persistence for a non-operator mutation', async () => {
    const userDataPath = root()
    __setCriticalSecureFileTestHooksForTests({ platform: 'win32' })

    await expect(
      runIdempotentEnvironmentRecipeMutation(
        userDataPath,
        'paired-device',
        'environmentRecipes.provision',
        { clientMutationId: 'local-recipe' },
        async () => result('local-runtime', 'running')
      )
    ).resolves.toMatchObject({ runtimeId: 'local-runtime' })
    expect(secureWrites).toEqual([])
  })

  it('rejects an operator mutation when critical persistence is unsupported', async () => {
    const userDataPath = root()
    const identity = {
      pairedDeviceId: 'paired-device',
      method: 'environmentRecipes.provision',
      clientMutationId: 'unsupported-platform'
    }
    __setCriticalSecureFileTestHooksForTests({ platform: 'win32' })

    await expect(
      runIdempotentEnvironmentRecipeMutation(
        userDataPath,
        identity.pairedDeviceId,
        identity.method,
        { clientMutationId: identity.clientMutationId },
        async (control) => {
          control.persistProvisionRef(provisionRef, 'unsupported-runtime')
          return result('unsupported-runtime', 'running')
        },
        { operatorRecipeCatalogSha256 }
      )
    ).rejects.toMatchObject({ code: 'environment_recipe_failed' })
    expect(readDurableEnvironmentRecipeMutation(userDataPath, identity)).toBeNull()
  })

  posixIt('does not acknowledge completion when its critical rename fails', async () => {
    const userDataPath = root()
    const identity = {
      pairedDeviceId: 'paired-device',
      method: 'environmentRecipes.provision',
      clientMutationId: 'completion-rename-failure'
    }
    const journalPath = getEnvironmentRecipeOperationJournalPath(userDataPath)
    let journalRenames = 0
    __setCriticalSecureFileTestHooksForTests({
      beforeStage: (stage, targetPath) => {
        if (stage === 'rename' && targetPath === journalPath && ++journalRenames === 2) {
          throw Object.assign(new Error('injected rename'), { code: 'EIO' })
        }
      }
    })

    await expect(
      runIdempotentEnvironmentRecipeMutation(
        userDataPath,
        identity.pairedDeviceId,
        identity.method,
        { clientMutationId: identity.clientMutationId },
        async (control) => {
          control.persistProvisionRef(provisionRef, 'completion-runtime')
          persistRuntimeBacking(
            userDataPath,
            'completion-runtime',
            control.requestSha256,
            'running'
          )
          return result('completion-runtime', 'running')
        },
        { operatorRecipeCatalogSha256 }
      )
    ).rejects.toMatchObject({ code: 'environment_recipe_failed' })
    expect(readDurableEnvironmentRecipeMutation(userDataPath, identity)?.state).toBe('prepared')
  })

  posixIt('persists successful runtime backing before completion and eviction', async () => {
    const userDataPath = root()
    const identity = {
      pairedDeviceId: 'paired-device',
      method: 'environmentRecipes.provision',
      clientMutationId: 'successful-runtime'
    }
    const runtimeId = 'successful-runtime-id'

    await runIdempotentEnvironmentRecipeMutation(
      userDataPath,
      identity.pairedDeviceId,
      identity.method,
      { clientMutationId: identity.clientMutationId },
      async (control) => {
        control.persistProvisionRef(provisionRef, runtimeId)
        persistRuntimeBacking(userDataPath, runtimeId, control.requestSha256, 'running')
        return result(runtimeId, 'running')
      },
      { operatorRecipeCatalogSha256 }
    )
    evictBackedMutation(userDataPath, identity.clientMutationId)

    expect(readDurableEnvironmentRecipeMutation(userDataPath, identity)).toBeNull()
    expectDurableWriteOrder(userDataPath)
  })

  posixIt.each(['cleaned', 'cleanup_failed'] as const)(
    'persists a %s tombstone before terminal transition and eviction',
    async (status) => {
      const userDataPath = root()
      const identity = {
        pairedDeviceId: 'paired-device',
        method: 'environmentRecipes.provision',
        clientMutationId: `terminal-${status}`
      }
      const runtimeId = `terminal-${status}-runtime`

      await expect(
        runIdempotentEnvironmentRecipeMutation(
          userDataPath,
          identity.pairedDeviceId,
          identity.method,
          { clientMutationId: identity.clientMutationId },
          async (control) => {
            control.persistProvisionRef(provisionRef, runtimeId)
            persistRuntimeBacking(userDataPath, runtimeId, control.requestSha256, status)
            control.markProvisionTerminal()
            throw new Error('terminal provision failure')
          },
          { operatorRecipeCatalogSha256 }
        )
      ).rejects.toMatchObject({ code: 'environment_recipe_failed' })
      evictBackedMutation(userDataPath, identity.clientMutationId)

      expect(readDurableEnvironmentRecipeMutation(userDataPath, identity)).toBeNull()
      expectDurableWriteOrder(userDataPath)
    }
  )

  posixIt.each(
    failureStages.flatMap((stage) => backedStatuses.map((status) => [stage, status] as const))
  )('keeps a %s-failed %s backing pinned as prepared', async (stage, status) => {
    const userDataPath = root()
    const clientMutationId = `${stage}-${status}`
    const identity = {
      pairedDeviceId: 'paired-device',
      method: 'environmentRecipes.provision',
      clientMutationId
    }
    const runtimePath = getEphemeralVmRuntimeStorePath(userDataPath)
    __setCriticalSecureFileTestHooksForTests({
      beforeStage: (candidate, targetPath) => {
        if (candidate === stage && targetPath === runtimePath) {
          const error = new Error(`injected ${stage}`) as NodeJS.ErrnoException
          error.code = stage === 'parent-dir-fsync' ? 'EINVAL' : 'EIO'
          throw error
        }
      }
    })

    await expect(
      runIdempotentEnvironmentRecipeMutation(
        userDataPath,
        identity.pairedDeviceId,
        identity.method,
        { clientMutationId },
        async (control) => {
          control.persistProvisionRef(provisionRef, `${clientMutationId}-runtime`)
          persistRuntimeBacking(
            userDataPath,
            `${clientMutationId}-runtime`,
            control.requestSha256,
            status
          )
          if (status !== 'running') {
            control.markProvisionTerminal()
          }
          return result(`${clientMutationId}-runtime`, status)
        },
        { operatorRecipeCatalogSha256 }
      )
    ).rejects.toMatchObject({ code: 'environment_recipe_failed' })

    expect(readDurableEnvironmentRecipeMutation(userDataPath, identity)?.state).toBe('prepared')
    expect(() => evictBackedMutation(userDataPath, clientMutationId)).toThrowError(
      expect.objectContaining({ code: 'capacity' })
    )
    expect(readDurableEnvironmentRecipeMutation(userDataPath, identity)?.state).toBe('prepared')
  })
})
