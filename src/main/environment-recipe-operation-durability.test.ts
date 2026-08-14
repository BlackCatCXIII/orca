import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as SecureFileModule from '../shared/secure-file'

const secureWrites = vi.hoisted(() => [] as { targetPath: string; durable: boolean }[])

vi.mock('../shared/secure-file', async (importOriginal) => {
  const actual = await importOriginal<typeof SecureFileModule>()
  return {
    ...actual,
    writeSecureFile(
      targetPath: string,
      contents: string,
      options: { durable?: boolean } = {}
    ): void {
      actual.writeSecureFile(targetPath, contents, options)
      secureWrites.push({ targetPath, durable: options.durable === true })
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
  resetEnvironmentRecipeOperationControlForTests,
  runIdempotentEnvironmentRecipeMutation
} from './environment-recipe-operation-control'
import {
  getEnvironmentRecipeOperationJournalPath,
  prepareDurableEnvironmentRecipeMutation,
  readDurableEnvironmentRecipeMutation
} from './environment-recipe-operation-journal'

const roots: string[] = []
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
    { targetPath: getEnvironmentRecipeOperationJournalPath(userDataPath), durable: true },
    {
      targetPath: getEphemeralVmRuntimeStorePath(userDataPath),
      durable: true
    },
    { targetPath: getEnvironmentRecipeOperationJournalPath(userDataPath), durable: true },
    { targetPath: getEnvironmentRecipeOperationJournalPath(userDataPath), durable: true }
  ])
}

afterEach(() => {
  resetEnvironmentRecipeOperationControlForTests()
  secureWrites.length = 0
  for (const path of roots.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('environment recipe operation durability ordering', () => {
  it('persists successful runtime backing before completion and eviction', async () => {
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

  it.each(['cleaned', 'cleanup_failed'] as const)(
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
})
