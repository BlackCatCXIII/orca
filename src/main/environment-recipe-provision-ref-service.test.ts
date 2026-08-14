import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeServiceModule from './ephemeral-vm-runtime-service'
import { upsertEphemeralVmRuntime } from '../shared/ephemeral-vm-runtime-store'
import type { Repo } from '../shared/repo-types'
import type { OperatorEnvironmentRecipeCatalog } from './operator-environment-recipe-catalog'
import { resolveEnvironmentRecipeProvisionRef } from './environment-recipe-provision-ref'

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
  provisionMock.mockImplementation(async (args: { runtimeId: string }) => {
    const runtime = upsertEphemeralVmRuntime(userDataPath, {
      id: args.runtimeId,
      repoId: targetRepo.id,
      recipeId: recipe.id,
      recipe,
      operatorRecipeCatalogSha256: catalog.status.digest,
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
  })
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('operator environment recipe provision ref service', () => {
  it('pins missing ref to HEAD once and retains it across restart replay after HEAD moves', async () => {
    let head = 'a'.repeat(40)
    const gitExec = vi.fn(async () => ({ stdout: `${head}\n` }))
    const resolver = (args: Parameters<typeof resolveEnvironmentRecipeProvisionRef>[0]) =>
      resolveEnvironmentRecipeProvisionRef(args, gitExec)
    const params = {
      repoId: targetRepo.id,
      recipeId: recipe.id,
      clientMutationId: 'pin-head'
    }

    await provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
    expect(provisionMock).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'a'.repeat(40), branch: undefined })
    )

    head = 'b'.repeat(40)
    await provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
    expect(gitExec).toHaveBeenCalledOnce()
    expect(provisionMock).toHaveBeenCalledOnce()

    resetEnvironmentRecipeRpcStateForTests()
    head = 'c'.repeat(40)
    await provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
    expect(gitExec).toHaveBeenCalledOnce()
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
