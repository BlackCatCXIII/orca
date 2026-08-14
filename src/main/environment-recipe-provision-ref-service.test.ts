import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeServiceModule from './ephemeral-vm-runtime-service'
import { upsertEphemeralVmRuntime } from '../shared/ephemeral-vm-runtime-store'
import type { Repo } from '../shared/repo-types'
import type { OperatorEnvironmentRecipeCatalog } from './operator-environment-recipe-catalog'
import { resolveEnvironmentRecipeProvisionRef } from './environment-recipe-provision-ref'
import { getEnvironmentRecipeOperationJournalPath } from './environment-recipe-operation-journal'

const provisionMock = vi.hoisted(() => vi.fn())

vi.mock('./ephemeral-vm-runtime-service', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeServiceModule>()),
  provisionEphemeralVmRuntime: provisionMock
}))

import {
  provisionEnvironmentRecipeForRpc,
  resetEnvironmentRecipeRpcStateForTests,
  type EnvironmentRecipeRuntimeRpcDependencies
} from './environment-recipe-runtime-rpc-service'

const recipe = {
  id: 'operator-box',
  name: 'Operator box',
  checkoutMode: 'provisioned-root' as const,
  create: '/operator/create'
}
const catalog: OperatorEnvironmentRecipeCatalog = {
  status: { enabled: true, digest: 'c'.repeat(64), recipeIds: [recipe.id] },
  listRecipes: () => [recipe],
  resolveRecipe: (id) => (id === recipe.id ? recipe : null)
}
const targetRepo: Repo = {
  id: 'repo-1',
  path: '/target/repo',
  displayName: 'target',
  badgeColor: '#000000',
  addedAt: 1,
  kind: 'git'
}

let userDataPath: string

function dependencies(
  repo: Repo = targetRepo,
  resolveProvisionRef?: EnvironmentRecipeRuntimeRpcDependencies['resolveProvisionRef']
): EnvironmentRecipeRuntimeRpcDependencies {
  return {
    runtime: { listRepos: () => [repo] },
    userDataPath,
    pairedDeviceId: 'paired-device',
    getPluginRecipes: async () => [],
    operatorRecipeCatalog: catalog,
    resolveProvisionRef
  }
}

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-operator-provision-ref-'))
  resetEnvironmentRecipeRpcStateForTests()
  provisionMock.mockReset()
  provisionMock.mockImplementation(
    async (args: {
      runtimeId: string
      provisionMutation?: { requestSha256: string; resolvedRef: string }
    }) => {
      const runtime = upsertEphemeralVmRuntime(userDataPath, {
        id: args.runtimeId,
        repoId: targetRepo.id,
        recipeId: recipe.id,
        recipe,
        operatorRecipeCatalogSha256: catalog.status.digest,
        ...(args.provisionMutation ? { provisionMutation: args.provisionMutation } : {}),
        status: 'running',
        cleanupStatus: 'not_started',
        connectionMode: 'ssh',
        sshTargetId: 'runtime-ssh-pinned',
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
              username: 'root',
              hostKey: { type: 'sha256', fingerprint: `SHA256:${'A'.repeat(43)}` }
            }
          }
        }
      })
      return { ok: true, runtime, start: { ok: true } }
    }
  )
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('operator environment recipe provision ref service', () => {
  it('replays the pinned ref after a side effect boundary crash and later runtime success', async () => {
    let head = 'a'.repeat(40)
    const gitExec = vi.fn(async () => ({ stdout: `${head}\n` }))
    const resolver = (args: Parameters<typeof resolveEnvironmentRecipeProvisionRef>[0]) =>
      resolveEnvironmentRecipeProvisionRef(args, gitExec)
    const params = {
      repoId: targetRepo.id,
      recipeId: recipe.id,
      clientMutationId: 'pin-head',
      workspaceName: 'Private workspace label'
    }
    provisionMock.mockImplementationOnce(async () => {
      throw new Error('crash after recipe invocation')
    })

    await expect(
      provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
    ).rejects.toMatchObject({ code: 'environment_recipe_failed' })
    expect(provisionMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ ref: 'a'.repeat(40), branch: undefined })
    )
    expect(
      readFileSync(getEnvironmentRecipeOperationJournalPath(userDataPath), 'utf8')
    ).not.toContain(params.workspaceName)

    resetEnvironmentRecipeRpcStateForTests()
    head = 'b'.repeat(40)
    await provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
    expect(gitExec).toHaveBeenCalledOnce()
    expect(provisionMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ ref: 'a'.repeat(40), branch: undefined })
    )

    resetEnvironmentRecipeRpcStateForTests()
    head = 'c'.repeat(40)
    await provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
    expect(gitExec).toHaveBeenCalledOnce()
    expect(provisionMock).toHaveBeenCalledTimes(2)
  })

  it('fails closed before recipe invocation when the durable pin cannot be written', async () => {
    const blockedUserDataPath = join(userDataPath, 'not-a-directory')
    writeFileSync(blockedUserDataPath, 'blocked', 'utf8')
    const resolver = vi.fn().mockResolvedValue('a'.repeat(40))

    await expect(
      provisionEnvironmentRecipeForRpc(
        { ...dependencies(targetRepo, resolver), userDataPath: blockedUserDataPath },
        {
          repoId: targetRepo.id,
          recipeId: recipe.id,
          clientMutationId: 'journal-write-failure'
        }
      )
    ).rejects.toMatchObject({ code: 'environment_recipe_failed' })
    expect(resolver).toHaveBeenCalledOnce()
    expect(provisionMock).not.toHaveBeenCalled()
  })

  it('rejects prepared replay after the operator catalog changes', async () => {
    const resolver = vi.fn().mockResolvedValue('a'.repeat(40))
    const params = {
      repoId: targetRepo.id,
      recipeId: recipe.id,
      clientMutationId: 'catalog-change'
    }
    provisionMock.mockRejectedValueOnce(new Error('crash after recipe invocation'))

    await expect(
      provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
    ).rejects.toMatchObject({ code: 'environment_recipe_failed' })
    resetEnvironmentRecipeRpcStateForTests()
    const changedCatalog: OperatorEnvironmentRecipeCatalog = {
      ...catalog,
      status: { ...catalog.status, digest: 'd'.repeat(64) }
    }

    await expect(
      Promise.resolve().then(() =>
        provisionEnvironmentRecipeForRpc(
          { ...dependencies(targetRepo, resolver), operatorRecipeCatalog: changedCatalog },
          params
        )
      )
    ).rejects.toMatchObject({ code: 'environment_recipe_conflict' })
    expect(resolver).toHaveBeenCalledOnce()
    expect(provisionMock).toHaveBeenCalledOnce()
  })

  it('preserves an explicit ref and does not read HEAD', async () => {
    const gitExec = vi.fn()
    const resolver = (args: Parameters<typeof resolveEnvironmentRecipeProvisionRef>[0]) =>
      resolveEnvironmentRecipeProvisionRef(args, gitExec)

    await provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), {
      repoId: targetRepo.id,
      recipeId: recipe.id,
      clientMutationId: 'explicit-ref',
      ref: 'refs/tags/operator-release'
    })

    expect(provisionMock).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'refs/tags/operator-release' })
    )
    expect(gitExec).not.toHaveBeenCalled()
  })

  it('rejects conflicting reuse of a durable mutation identity after restart', async () => {
    const resolver = vi.fn().mockResolvedValue('a'.repeat(40))
    const params = {
      repoId: targetRepo.id,
      recipeId: recipe.id,
      clientMutationId: 'strict-conflict',
      workspaceName: 'first'
    }

    await provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
    resetEnvironmentRecipeRpcStateForTests()

    await expect(
      Promise.resolve().then(() =>
        provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), {
          ...params,
          workspaceName: 'different'
        })
      )
    ).rejects.toMatchObject({ code: 'environment_recipe_conflict' })
    expect(resolver).toHaveBeenCalledOnce()
    expect(provisionMock).toHaveBeenCalledOnce()
  })

  it('rejects replay after a recipe-start failure reached terminal cleanup', async () => {
    const resolver = vi.fn().mockResolvedValue('a'.repeat(40))
    const params = {
      repoId: targetRepo.id,
      recipeId: recipe.id,
      clientMutationId: 'terminal-start-failure'
    }
    provisionMock.mockImplementationOnce(
      async (args: { onTerminalProvisionFailure?: () => void }) => {
        args.onTerminalProvisionFailure?.()
        return { ok: false, start: { ok: false, error: 'start failed', recipeResult: {} } }
      }
    )

    await expect(
      Promise.resolve().then(() =>
        provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
      )
    ).rejects.toMatchObject({ code: 'environment_recipe_failed' })

    await expect(
      Promise.resolve().then(() =>
        provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
      )
    ).rejects.toMatchObject({
      code: 'environment_recipe_conflict',
      message: expect.stringContaining('new attempt')
    })
    resetEnvironmentRecipeRpcStateForTests()
    await expect(
      Promise.resolve().then(() =>
        provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
      )
    ).rejects.toMatchObject({
      code: 'environment_recipe_conflict',
      message: expect.stringContaining('new attempt')
    })
    resetEnvironmentRecipeRpcStateForTests()
    await expect(
      Promise.resolve().then(() =>
        provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), {
          ...params,
          workspaceName: 'conflicting terminal reuse'
        })
      )
    ).rejects.toMatchObject({
      code: 'environment_recipe_conflict',
      message: expect.stringContaining('different recipe request')
    })
    expect(resolver).toHaveBeenCalledOnce()
    expect(provisionMock).toHaveBeenCalledOnce()
  })

  it('uses runtime bindings for strict replay after completed journal retention', async () => {
    const resolver = vi.fn().mockResolvedValue('a'.repeat(40))
    const params = {
      repoId: targetRepo.id,
      recipeId: recipe.id,
      clientMutationId: 'runtime-binding'
    }

    await provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
    rmSync(getEnvironmentRecipeOperationJournalPath(userDataPath))
    resetEnvironmentRecipeRpcStateForTests()

    await expect(
      provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
    ).resolves.toMatchObject({ repoId: targetRepo.id, recipeId: recipe.id })
    resetEnvironmentRecipeRpcStateForTests()
    await expect(
      provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), {
        ...params,
        ref: 'b'.repeat(40)
      })
    ).rejects.toMatchObject({ code: 'environment_recipe_conflict' })
    resetEnvironmentRecipeRpcStateForTests()
    await expect(
      provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), {
        ...params,
        branch: 'moved-branch'
      })
    ).rejects.toMatchObject({ code: 'environment_recipe_conflict' })
    expect(resolver).toHaveBeenCalledOnce()
    expect(provisionMock).toHaveBeenCalledOnce()
  })

  it('uses a cleaned runtime tombstone after terminal journal retention', async () => {
    const resolver = vi.fn().mockResolvedValue('a'.repeat(40))
    const params = {
      repoId: targetRepo.id,
      recipeId: recipe.id,
      clientMutationId: 'terminal-runtime-binding'
    }
    provisionMock.mockImplementationOnce(
      async (args: {
        runtimeId: string
        provisionMutation: { requestSha256: string; resolvedRef: string }
        onTerminalProvisionFailure: () => void
      }) => {
        upsertEphemeralVmRuntime(userDataPath, {
          id: args.runtimeId,
          repoId: targetRepo.id,
          recipeId: recipe.id,
          recipe,
          operatorRecipeCatalogSha256: catalog.status.digest,
          provisionMutation: args.provisionMutation,
          status: 'cleaned',
          cleanupStatus: 'succeeded',
          connectionMode: 'ssh',
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
                username: 'root',
                hostKey: { type: 'sha256', fingerprint: `SHA256:${'A'.repeat(43)}` }
              }
            }
          }
        })
        args.onTerminalProvisionFailure()
        return { ok: false, start: { ok: false, error: 'start failed', recipeResult: {} } }
      }
    )

    await expect(
      provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
    ).rejects.toMatchObject({ code: 'environment_recipe_failed' })
    rmSync(getEnvironmentRecipeOperationJournalPath(userDataPath))
    resetEnvironmentRecipeRpcStateForTests()

    await expect(
      provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
    ).rejects.toMatchObject({
      code: 'environment_recipe_conflict',
      message: expect.stringContaining('new attempt')
    })
    resetEnvironmentRecipeRpcStateForTests()
    await expect(
      provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), {
        ...params,
        branch: 'conflict'
      })
    ).rejects.toMatchObject({ code: 'environment_recipe_conflict' })
    expect(resolver).toHaveBeenCalledOnce()
    expect(provisionMock).toHaveBeenCalledOnce()
  })

  it('leaves missing-ref nonoperator provisioning unchanged', async () => {
    const resolver = vi.fn().mockResolvedValue(undefined)
    const deps = {
      ...dependencies(targetRepo, resolver),
      operatorRecipeCatalog: undefined,
      getPluginRecipes: async () => [recipe]
    }

    await provisionEnvironmentRecipeForRpc(deps, {
      repoId: targetRepo.id,
      recipeId: recipe.id,
      clientMutationId: 'legacy-missing-ref'
    })

    expect(provisionMock).toHaveBeenCalledWith(
      expect.objectContaining({ ref: undefined, branch: undefined, executionMode: 'shell' })
    )
  })

  it.each(['missing', 'unborn', 'ambiguous', 'noncommit', 'vanished'])(
    'fails before recipe invocation when target HEAD is %s',
    async (state) => {
      const resolver = vi.fn().mockRejectedValue(new Error(`${state} HEAD`))

      await expect(
        provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), {
          repoId: targetRepo.id,
          recipeId: recipe.id,
          clientMutationId: `invalid-head-${state}`
        })
      ).rejects.toMatchObject({ code: 'environment_recipe_failed' })
      expect(provisionMock).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['folder', { ...targetRepo, kind: 'folder' as const }],
    ['remote', { ...targetRepo, connectionId: 'remote-target' }]
  ])('rejects an ineligible %s target before ref resolution', async (_name, repo) => {
    const resolver = vi.fn()

    await expect(
      provisionEnvironmentRecipeForRpc(dependencies(repo, resolver), {
        repoId: repo.id,
        recipeId: recipe.id,
        clientMutationId: `ineligible-${_name}`
      })
    ).rejects.toMatchObject({ code: 'environment_recipe_not_found' })
    expect(resolver).not.toHaveBeenCalled()
    expect(provisionMock).not.toHaveBeenCalled()
  })
})
