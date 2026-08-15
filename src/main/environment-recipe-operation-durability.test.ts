import { mkdtempSync, rmSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as SecureFileModule from '../shared/secure-file'
import type * as SecureFileFilesystem from '../shared/secure-file-filesystem'

type CriticalSecureFileStage = 'temp-fsync' | 'rename' | 'parent-dir-fsync' | 'authority-file-fsync'

const filesystemFailure = vi.hoisted(() => ({
  stage: null as CriticalSecureFileStage | null,
  targetPath: null as string | null,
  lastRenamedTargetPath: null as string | null,
  authorityTargetObserved: false
}))

vi.mock('../shared/secure-file-filesystem', async (importOriginal) => {
  const actual = await importOriginal<typeof SecureFileFilesystem>()
  const nodeFs = await vi.importActual<typeof NodeFs>('node:fs')
  const shouldFail = (stage: CriticalSecureFileStage, targetPath: string): boolean =>
    filesystemFailure.stage === stage && filesystemFailure.targetPath === targetPath
  const descriptorMatches = (descriptor: number, targetPath: string): boolean => {
    try {
      const descriptorStats = nodeFs.fstatSync(descriptor, { bigint: true })
      const targetStats = nodeFs.lstatSync(targetPath, { bigint: true })
      return descriptorStats.dev === targetStats.dev && descriptorStats.ino === targetStats.ino
    } catch {
      return false
    }
  }
  return {
    ...actual,
    fsyncSecurePathSync(path: string, flags: 'r' | 'r+'): void {
      const directory = nodeFs.statSync(path).isDirectory()
      const stage = directory ? 'parent-dir-fsync' : 'temp-fsync'
      const targetPath = directory
        ? filesystemFailure.lastRenamedTargetPath
        : path.replace(/\.\d+\.\d+\.[0-9a-f]+\.tmp$/, '')
      if (targetPath && shouldFail(stage, targetPath)) {
        throw Object.assign(new Error(`injected ${stage}`), {
          code: stage === 'parent-dir-fsync' ? 'EINVAL' : 'EIO'
        })
      }
      actual.fsyncSecurePathSync(path, flags)
    },
    renameSecureFileSync(sourcePath: string, targetPath: string): void {
      if (shouldFail('rename', targetPath)) {
        throw Object.assign(new Error('injected rename'), { code: 'EIO' })
      }
      actual.renameSecureFileSync(sourcePath, targetPath)
      filesystemFailure.lastRenamedTargetPath = targetPath
    },
    fsyncSecureFileDescriptorSync(descriptor: number): void {
      filesystemFailure.authorityTargetObserved = Boolean(
        filesystemFailure.targetPath && descriptorMatches(descriptor, filesystemFailure.targetPath)
      )
      if (
        filesystemFailure.stage === 'authority-file-fsync' &&
        filesystemFailure.authorityTargetObserved
      ) {
        throw Object.assign(new Error('injected authority file fsync'), { code: 'EIO' })
      }
      actual.fsyncSecureFileDescriptorSync(descriptor)
    },
    fsyncSecureDirectoryDescriptorSync(descriptor: number): void {
      if (
        filesystemFailure.stage === 'parent-dir-fsync' &&
        filesystemFailure.authorityTargetObserved
      ) {
        filesystemFailure.authorityTargetObserved = false
        throw Object.assign(new Error('injected parent-dir-fsync'), { code: 'EINVAL' })
      }
      filesystemFailure.authorityTargetObserved = false
      actual.fsyncSecureDirectoryDescriptorSync(descriptor)
    }
  }
})

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
  EphemeralVmRuntimeStoreError,
  getEphemeralVmRuntimeStorePath,
  upsertEphemeralVmRuntime
} from '../shared/ephemeral-vm-runtime-store'
import { getEphemeralVmRuntimeFeatureStorePath } from '../shared/ephemeral-vm-runtime-feature-store'
import type { EphemeralVmRuntimeStatus } from '../shared/ephemeral-vm-runtimes'
import type { EnvironmentRecipeRuntime } from '../shared/environment-recipe-runtime-rpc'
import {
  resetEnvironmentRecipeOperationControlForTests,
  runIdempotentEnvironmentRecipeMutation,
  type EnvironmentRecipeMutationControl
} from './environment-recipe-operation-control'
import {
  getEnvironmentRecipeOperationJournalPath,
  classifyDurableEnvironmentRecipeMutationFromStore,
  prepareDurableEnvironmentRecipeMutation,
  readDurableEnvironmentRecipeMutation
} from './environment-recipe-operation-journal'

const roots: string[] = []
const posixIt = process.platform === 'win32' ? it.skip : it
const operatorRecipeCatalogSha256 = 'c'.repeat(64)
const provisionRef = 'a'.repeat(40)
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

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
      targetPath: getEphemeralVmRuntimeFeatureStorePath(userDataPath),
      durability: 'best-effort'
    },
    {
      targetPath: getEnvironmentRecipeOperationJournalPath(userDataPath),
      durability: 'critical'
    }
  ])
}

afterEach(() => {
  resetEnvironmentRecipeOperationControlForTests()
  filesystemFailure.stage = null
  filesystemFailure.targetPath = null
  filesystemFailure.lastRenamedTargetPath = null
  filesystemFailure.authorityTargetObserved = false
  secureWrites.length = 0
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  for (const path of roots.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

const failureStages: CriticalSecureFileStage[] = ['temp-fsync', 'rename', 'parent-dir-fsync']
const backedStatuses: EphemeralVmRuntimeStatus[] = ['running', 'cleaned', 'cleanup_failed']

describe('environment recipe operation durability ordering', () => {
  it('does not require critical persistence for a non-operator mutation', async () => {
    const userDataPath = root()
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
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const recipeInvocation = vi.fn(async () => result('unsupported-runtime', 'running'))

    await expect(
      runIdempotentEnvironmentRecipeMutation(
        userDataPath,
        identity.pairedDeviceId,
        identity.method,
        { clientMutationId: identity.clientMutationId },
        async (control) => {
          control.persistProvisionRef(provisionRef, 'unsupported-runtime')
          return recipeInvocation()
        },
        { operatorRecipeCatalogSha256 }
      )
    ).rejects.toMatchObject({ code: 'environment_recipe_failed' })
    expect(recipeInvocation).not.toHaveBeenCalled()
    expect(readDurableEnvironmentRecipeMutation(userDataPath, identity)).toBeNull()
  })

  posixIt(
    'recovers completion from an exact runtime after parent-directory fsync failure',
    async () => {
      const userDataPath = root()
      const identity = {
        pairedDeviceId: 'paired-device',
        method: 'environmentRecipes.provision',
        clientMutationId: 'completion-parent-fsync-failure'
      }
      const runtimePath = getEphemeralVmRuntimeStorePath(userDataPath)
      filesystemFailure.stage = 'parent-dir-fsync'
      filesystemFailure.targetPath = runtimePath

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
      const durable = readDurableEnvironmentRecipeMutation(userDataPath, identity)
      expect(durable?.state).toBe('prepared')
      expect(
        () => durable && classifyDurableEnvironmentRecipeMutationFromStore(userDataPath, durable)
      ).toThrow(EphemeralVmRuntimeStoreError)
      resetEnvironmentRecipeOperationControlForTests()
      const replayOperation = vi.fn(async (_control: EnvironmentRecipeMutationControl) =>
        result('completion-runtime', 'running')
      )
      await expect(
        runIdempotentEnvironmentRecipeMutation(
          userDataPath,
          identity.pairedDeviceId,
          identity.method,
          { clientMutationId: identity.clientMutationId },
          replayOperation,
          { operatorRecipeCatalogSha256 }
        )
      ).rejects.toMatchObject({ code: 'environment_recipe_failed' })
      expect(replayOperation).not.toHaveBeenCalled()

      filesystemFailure.stage = 'authority-file-fsync'
      expect(
        () => durable && classifyDurableEnvironmentRecipeMutationFromStore(userDataPath, durable)
      ).toThrow(EphemeralVmRuntimeStoreError)
      await expect(
        runIdempotentEnvironmentRecipeMutation(
          userDataPath,
          identity.pairedDeviceId,
          identity.method,
          { clientMutationId: identity.clientMutationId },
          replayOperation,
          { operatorRecipeCatalogSha256 }
        )
      ).rejects.toMatchObject({ code: 'environment_recipe_failed' })
      expect(replayOperation).not.toHaveBeenCalled()

      filesystemFailure.stage = null
      expect(
        durable && classifyDurableEnvironmentRecipeMutationFromStore(userDataPath, durable)
      ).toBe('completed')
      filesystemFailure.targetPath = null
      replayOperation.mockImplementation(async (control) => {
        expect(control).toMatchObject({
          provisionRef,
          runtimeId: 'completion-runtime'
        })
        return result('completion-runtime', 'running')
      })
      await expect(
        runIdempotentEnvironmentRecipeMutation(
          userDataPath,
          identity.pairedDeviceId,
          identity.method,
          { clientMutationId: identity.clientMutationId },
          replayOperation,
          { operatorRecipeCatalogSha256 }
        )
      ).resolves.toMatchObject({ runtimeId: 'completion-runtime' })
      expect(replayOperation).toHaveBeenCalledOnce()
    }
  )

  posixIt(
    'recovers terminal replay from an exact tombstone after parent-directory fsync failure',
    async () => {
      const userDataPath = root()
      const identity = {
        pairedDeviceId: 'paired-device',
        method: 'environmentRecipes.provision',
        clientMutationId: 'terminal-parent-fsync-failure'
      }
      filesystemFailure.stage = 'parent-dir-fsync'
      filesystemFailure.targetPath = getEphemeralVmRuntimeStorePath(userDataPath)

      await expect(
        runIdempotentEnvironmentRecipeMutation(
          userDataPath,
          identity.pairedDeviceId,
          identity.method,
          { clientMutationId: identity.clientMutationId },
          async (control) => {
            control.persistProvisionRef(provisionRef, 'terminal-runtime')
            persistRuntimeBacking(
              userDataPath,
              'terminal-runtime',
              control.requestSha256,
              'cleaned'
            )
            control.markProvisionTerminal()
            throw new Error('terminal provision failure')
          },
          { operatorRecipeCatalogSha256 }
        )
      ).rejects.toMatchObject({ code: 'environment_recipe_failed' })
      const durable = readDurableEnvironmentRecipeMutation(userDataPath, identity)
      expect(durable?.state).toBe('prepared')
      expect(
        () => durable && classifyDurableEnvironmentRecipeMutationFromStore(userDataPath, durable)
      ).toThrow(EphemeralVmRuntimeStoreError)
      resetEnvironmentRecipeOperationControlForTests()
      const replayOperation = vi.fn()
      await expect(
        runIdempotentEnvironmentRecipeMutation(
          userDataPath,
          identity.pairedDeviceId,
          identity.method,
          { clientMutationId: identity.clientMutationId },
          replayOperation,
          { operatorRecipeCatalogSha256 }
        )
      ).rejects.toMatchObject({ code: 'environment_recipe_failed' })
      expect(replayOperation).not.toHaveBeenCalled()

      filesystemFailure.stage = null
      expect(
        durable && classifyDurableEnvironmentRecipeMutationFromStore(userDataPath, durable)
      ).toBe('terminal')
      filesystemFailure.targetPath = null
      await expect(
        runIdempotentEnvironmentRecipeMutation(
          userDataPath,
          identity.pairedDeviceId,
          identity.method,
          { clientMutationId: identity.clientMutationId },
          replayOperation,
          { operatorRecipeCatalogSha256 }
        )
      ).rejects.toMatchObject({ code: 'environment_recipe_conflict' })
      expect(replayOperation).not.toHaveBeenCalled()
    }
  )

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
  )('handles a %s-failed %s backing without rewriting prepared identity', async (stage, status) => {
    const userDataPath = root()
    const clientMutationId = `${stage}-${status}`
    const identity = {
      pairedDeviceId: 'paired-device',
      method: 'environmentRecipes.provision',
      clientMutationId
    }
    const runtimePath = getEphemeralVmRuntimeStorePath(userDataPath)
    filesystemFailure.stage = stage
    filesystemFailure.targetPath = runtimePath

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
    if (stage === 'parent-dir-fsync') {
      expect(() => evictBackedMutation(userDataPath, clientMutationId)).toThrow(
        EphemeralVmRuntimeStoreError
      )
      filesystemFailure.stage = 'authority-file-fsync'
      expect(() => evictBackedMutation(userDataPath, clientMutationId)).toThrow(
        EphemeralVmRuntimeStoreError
      )
      filesystemFailure.stage = null
      filesystemFailure.targetPath = null
      evictBackedMutation(userDataPath, clientMutationId)
      expect(readDurableEnvironmentRecipeMutation(userDataPath, identity)).toBeNull()
    } else {
      filesystemFailure.stage = null
      filesystemFailure.targetPath = null
      expect(() => evictBackedMutation(userDataPath, clientMutationId)).toThrowError(
        expect.objectContaining({ code: 'capacity' })
      )
      expect(readDurableEnvironmentRecipeMutation(userDataPath, identity)?.state).toBe('prepared')
    }
  })
})
