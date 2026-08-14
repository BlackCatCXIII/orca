import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaVmRecipe } from '../shared/orca-yaml-hook-types'
import type * as EphemeralVmRuntimeServiceModule from './ephemeral-vm-runtime-service'
import type * as EphemeralVmRuntimeSshModule from './ephemeral-vm-runtime-ssh'
import {
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus,
  upsertEphemeralVmRuntime
} from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'

const mocks = vi.hoisted(() => ({
  provision: vi.fn(),
  suspend: vi.fn(),
  resume: vi.fn(),
  cleanup: vi.fn(),
  connectSsh: vi.fn(),
  disconnectSsh: vi.fn(),
  removeSsh: vi.fn()
}))

vi.mock('./ephemeral-vm-runtime-service', async (importOriginal) => ({
  ...(await importOriginal<typeof EphemeralVmRuntimeServiceModule>()),
  provisionEphemeralVmRuntime: mocks.provision,
  suspendEphemeralVmRuntime: mocks.suspend,
  resumeEphemeralVmRuntime: mocks.resume,
  cleanupEphemeralVmRuntime: mocks.cleanup
}))

vi.mock('./ephemeral-vm-runtime-ssh', async (importOriginal) => ({
  ...(await importOriginal<typeof EphemeralVmRuntimeSshModule>()),
  connectRuntimeOwnedSshTarget: mocks.connectSsh,
  disconnectRuntimeOwnedSshTarget: mocks.disconnectSsh,
  removeRuntimeOwnedSshTarget: mocks.removeSsh
}))

import {
  destroyEnvironmentRecipeForRpc,
  listEnvironmentRecipeRuntimesForRpc,
  listEnvironmentRecipesForRpc,
  provisionEnvironmentRecipeForRpc,
  resetEnvironmentRecipeRpcStateForTests,
  resumeEnvironmentRecipeForRpc,
  suspendEnvironmentRecipeForRpc,
  type EnvironmentRecipeRuntimeRpcDependencies
} from './environment-recipe-runtime-rpc-service'

const recipe: OrcaVmRecipe = {
  id: 'cloud-box',
  name: 'Cloud box',
  create: 'provider create',
  checkoutMode: 'provisioned-root',
  suspend: 'provider suspend',
  resume: 'provider resume',
  destroy: 'provider destroy'
}

const TEST_HOST_FINGERPRINT = `SHA256:${'A'.repeat(43)}`

let userDataPath: string

function deps(): EnvironmentRecipeRuntimeRpcDependencies {
  return {
    runtime: {
      listRepos: () => [
        {
          id: 'repo-1',
          path: '/host/source-repo',
          displayName: 'source-repo',
          badgeColor: '#000000',
          addedAt: 1,
          kind: 'git',
          gitRemoteIdentity: {
            remoteUrl: 'git@github.com:stablyai/orca.git',
            canonicalKey: 'github.com/stablyai/orca',
            remoteName: 'origin'
          }
        }
      ]
    },
    userDataPath,
    pairedDeviceId: 'paired-phone',
    getPluginRecipes: async () => [recipe]
  }
}

function runningRuntime(
  overrides: Partial<EphemeralVmRuntimeRecord> = {}
): EphemeralVmRuntimeRecord {
  return {
    id: 'runtime-existing',
    repoId: 'repo-1',
    recipeId: recipe.id,
    recipe,
    status: 'running',
    cleanupStatus: 'not_started',
    connectionMode: 'ssh',
    sshTargetId: 'runtime-ssh-runtime-existing',
    createdAt: 1,
    updatedAt: 1,
    recipeResult: {
      schemaVersion: 2,
      checkoutMode: 'provisioned-root',
      connection: {
        type: 'ssh',
        projectRoot: '/srv/repo',
        target: {
          label: 'cloud-box',
          host: '10.0.0.8',
          port: 22,
          username: 'root',
          hostKey: { type: 'sha256', fingerprint: TEST_HOST_FINGERPRINT },
          identityFile: '/secret/key'
        }
      },
      userData: { accessToken: 'secret-token' }
    },
    ...overrides
  }
}

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-environment-recipe-rpc-'))
  resetEnvironmentRecipeRpcStateForTests()
  vi.clearAllMocks()
  mocks.connectSsh.mockResolvedValue({
    targetId: 'runtime-ssh-provisioned',
    target: { id: 'runtime-ssh-provisioned' }
  })
  mocks.disconnectSsh.mockResolvedValue(undefined)
  mocks.removeSsh.mockResolvedValue(undefined)
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('remote environment recipe runtime service', () => {
  it('recovers durable host-owned runtime IDs without exposing provider metadata', async () => {
    upsertEphemeralVmRuntime(userDataPath, runningRuntime())
    upsertEphemeralVmRuntime(
      userDataPath,
      runningRuntime({ id: 'runtime-cleaned', status: 'cleaned' })
    )

    const result = await listEnvironmentRecipeRuntimesForRpc(deps(), 'repo-1')

    expect(result.runtimes).toHaveLength(1)
    expect(result.runtimes[0]).toMatchObject({ runtimeId: 'runtime-existing', status: 'running' })
    expect(JSON.stringify(result)).not.toContain('secret-token')
    expect(JSON.stringify(result)).not.toContain('/secret/key')
    expect(JSON.stringify(result)).not.toContain(TEST_HOST_FINGERPRINT)
  })

  it('does not execute recipes from an SSH or nested-runtime repo projection', async () => {
    const remoteDeps = deps()
    const [repo] = remoteDeps.runtime.listRepos()
    remoteDeps.runtime = {
      listRepos: () => [{ ...repo!, executionHostId: 'runtime:nested-host' }]
    }

    await expect(listEnvironmentRecipesForRpc(remoteDeps, 'repo-1')).rejects.toMatchObject({
      code: 'environment_recipe_not_found'
    })
  })

  it('provisions once on the host and returns only provisioned-root adoption metadata', async () => {
    mocks.provision.mockImplementation(async (args: { runtimeId: string }) => {
      const runtime = upsertEphemeralVmRuntime(
        userDataPath,
        runningRuntime({ id: args.runtimeId, sshTargetId: undefined })
      )
      return {
        ok: true,
        runtime,
        start: { ok: true, context: {}, result: runtime.recipeResult, stdout: '', stderr: '' }
      }
    })
    const params = {
      repoId: 'repo-1',
      recipeId: recipe.id,
      clientMutationId: 'provision-1'
    }

    const [first, replay] = await Promise.all([
      provisionEnvironmentRecipeForRpc(deps(), params),
      provisionEnvironmentRecipeForRpc(deps(), params)
    ])

    expect(mocks.provision).toHaveBeenCalledOnce()
    expect(mocks.provision).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: '/host/source-repo',
        repoUrl: 'git@github.com:stablyai/orca.git',
        runtimeId: expect.stringMatching(/^remote-recipe-[a-f0-9]{32}$/)
      })
    )
    expect(mocks.connectSsh).toHaveBeenCalledWith({
      runtimeId: first.runtimeId,
      connection: expect.objectContaining({
        type: 'ssh',
        target: expect.objectContaining({
          hostKey: { type: 'sha256', fingerprint: TEST_HOST_FINGERPRINT }
        })
      })
    })
    expect(first).toEqual(replay)
    expect(first).toMatchObject({
      connectionType: 'ssh',
      adoption: {
        connectionId: 'runtime-ssh-provisioned',
        executionHostId: 'ssh:runtime-ssh-provisioned',
        expectedPath: '/srv/repo'
      }
    })
    expect(JSON.stringify(first)).not.toContain('secret')
    expect(JSON.stringify(first)).not.toContain(TEST_HOST_FINGERPRINT)
  })

  it('bounds unexpected host failures without returning provider output', async () => {
    mocks.provision.mockRejectedValue(new Error('token=secret-token provider log'.repeat(100)))

    const failure = await provisionEnvironmentRecipeForRpc(deps(), {
      repoId: 'repo-1',
      recipeId: recipe.id,
      clientMutationId: 'provision-failure'
    }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'environment_recipe_failed' })
    expect(String(failure)).not.toContain('secret-token')
    expect(String(failure).length).toBeLessThanOrEqual(512)
  })

  it('enforces repo and recipe ownership before lifecycle execution', async () => {
    upsertEphemeralVmRuntime(userDataPath, runningRuntime())

    await expect(
      suspendEnvironmentRecipeForRpc(deps(), {
        repoId: 'other-repo',
        recipeId: recipe.id,
        runtimeId: 'runtime-existing',
        clientMutationId: 'suspend-1'
      })
    ).rejects.toMatchObject({ code: 'environment_recipe_not_found' })
    expect(mocks.suspend).not.toHaveBeenCalled()
  })

  it('makes repeated suspend requests state-idempotent across mutation ids', async () => {
    upsertEphemeralVmRuntime(userDataPath, runningRuntime())
    mocks.suspend.mockImplementation(async () => ({
      ok: true,
      skipped: false,
      runtime: updateEphemeralVmRuntimeStatus(userDataPath, 'runtime-existing', {
        status: 'suspended'
      })
    }))
    const base = {
      repoId: 'repo-1',
      recipeId: recipe.id,
      runtimeId: 'runtime-existing'
    }

    await Promise.all([
      suspendEnvironmentRecipeForRpc(deps(), { ...base, clientMutationId: 'suspend-1' }),
      suspendEnvironmentRecipeForRpc(deps(), { ...base, clientMutationId: 'suspend-2' })
    ])

    expect(mocks.suspend).toHaveBeenCalledOnce()
    expect(mocks.disconnectSsh).toHaveBeenCalledOnce()
  })

  it('resumes on the host and refreshes its host-owned SSH adoption target', async () => {
    upsertEphemeralVmRuntime(userDataPath, runningRuntime({ status: 'suspended' }))
    mocks.resume.mockImplementation(async () => ({
      ok: true,
      skipped: false,
      runtime: updateEphemeralVmRuntimeStatus(userDataPath, 'runtime-existing', {
        status: 'running'
      })
    }))

    const resumed = await resumeEnvironmentRecipeForRpc(deps(), {
      repoId: 'repo-1',
      recipeId: recipe.id,
      runtimeId: 'runtime-existing',
      clientMutationId: 'resume-1'
    })

    expect(mocks.resume).toHaveBeenCalledOnce()
    expect(mocks.connectSsh).toHaveBeenCalledOnce()
    expect(resumed).toMatchObject({
      status: 'running',
      adoption: { connectionId: 'runtime-ssh-provisioned' }
    })
  })

  it('removes host-owned SSH metadata even when provider destroy fails', async () => {
    upsertEphemeralVmRuntime(userDataPath, runningRuntime())
    mocks.cleanup.mockResolvedValue({
      ok: false,
      runtime: runningRuntime({ status: 'cleanup_failed', cleanupStatus: 'failed' }),
      error: 'token=secret-token provider log'.repeat(100)
    })

    const failure = await destroyEnvironmentRecipeForRpc(deps(), {
      repoId: 'repo-1',
      recipeId: recipe.id,
      runtimeId: 'runtime-existing',
      clientMutationId: 'destroy-1'
    }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'environment_recipe_failed' })
    expect(String(failure)).not.toContain('secret-token')
    expect(String(failure).length).toBeLessThanOrEqual(512)
    expect(mocks.removeSsh).toHaveBeenCalledWith('runtime-ssh-runtime-existing')
    expect(listEphemeralVmRuntimes(userDataPath)[0]?.sshTargetId).toBeUndefined()
  })
})
