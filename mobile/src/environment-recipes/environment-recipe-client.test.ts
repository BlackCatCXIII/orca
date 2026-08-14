import { describe, expect, it, vi } from 'vitest'
import {
  ENVIRONMENT_RECIPE_LIFECYCLE_RUNTIME_CAPABILITY,
  ENVIRONMENT_RECIPE_MANAGEMENT_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import type { RpcResponse } from '../transport/types'
import {
  listMobileEnvironmentRecipeRuntimes,
  listMobileEnvironmentRecipes,
  provisionMobileEnvironmentRecipe,
  suspendMobileEnvironmentRecipe
} from './environment-recipe-client'

const capabilities = [
  ENVIRONMENT_RECIPE_LIFECYCLE_RUNTIME_CAPABILITY,
  ENVIRONMENT_RECIPE_MANAGEMENT_RUNTIME_CAPABILITY
]

function success(result: unknown): RpcResponse {
  return { id: 'rpc-1', ok: true, result, _meta: { runtimeId: 'host-1' } }
}

function runtimeResult(): Record<string, unknown> {
  return {
    runtimeId: 'runtime-1',
    repoId: 'repo-1',
    recipeId: 'recipe-1',
    checkoutMode: 'provisioned-root',
    status: 'running',
    lifecycle: { suspend: true, resume: true, destroy: true },
    createdAt: 1,
    updatedAt: 2,
    connectionType: 'ssh',
    projectRoot: '/srv/repo',
    sshTargetId: 'runtime-ssh-runtime-1',
    adoption: {
      runtimeId: 'runtime-1',
      sourceRepoId: 'repo-1',
      connectionId: 'runtime-ssh-runtime-1',
      executionHostId: 'ssh:runtime-ssh-runtime-1',
      expectedPath: '/srv/repo'
    }
  }
}

describe('mobile environment recipe client', () => {
  it('does not call additive methods until the host advertises support', async () => {
    const sendRequest = vi.fn()

    await expect(listMobileEnvironmentRecipes({ sendRequest }, [], 'repo-1')).rejects.toThrow(
      'Update Orca on this host'
    )
    await expect(
      provisionMobileEnvironmentRecipe({ sendRequest }, [], {
        repoId: 'repo-1',
        recipeId: 'recipe-1',
        clientMutationId: 'provision-1'
      })
    ).rejects.toThrow('Update Orca on this host')
    await expect(
      suspendMobileEnvironmentRecipe({ sendRequest }, [], {
        repoId: 'repo-1',
        recipeId: 'recipe-1',
        runtimeId: 'runtime-1',
        clientMutationId: 'suspend-1'
      })
    ).rejects.toThrow('Update Orca on this host')
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('lists scoped recipe descriptors without accepting command fields', async () => {
    const sendRequest = vi.fn().mockResolvedValue(
      success({
        repoId: 'repo-1',
        recipes: [
          {
            repoId: 'repo-1',
            recipeId: 'recipe-1',
            name: 'Cloud box',
            checkoutMode: 'provisioned-root',
            lifecycle: { suspend: true, resume: true, destroy: true }
          }
        ]
      })
    )

    await expect(
      listMobileEnvironmentRecipes({ sendRequest }, capabilities, 'repo-1')
    ).resolves.toMatchObject({ recipes: [{ recipeId: 'recipe-1' }] })
    expect(sendRequest).toHaveBeenCalledWith('environmentRecipes.list', { repoId: 'repo-1' })
  })

  it('does not send runtime discovery to a lifecycle-only host', async () => {
    const sendRequest = vi.fn()

    await expect(
      listMobileEnvironmentRecipeRuntimes(
        { sendRequest },
        [ENVIRONMENT_RECIPE_LIFECYCLE_RUNTIME_CAPABILITY],
        'repo-1'
      )
    ).rejects.toThrow('Update Orca on this host')
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('discovers durable host runtime IDs without accepting provider fields', async () => {
    const sendRequest = vi.fn().mockResolvedValue(
      success({
        repoId: 'repo-1',
        runtimes: [runtimeResult()]
      })
    )

    await expect(
      listMobileEnvironmentRecipeRuntimes({ sendRequest }, capabilities, 'repo-1')
    ).resolves.toMatchObject({ runtimes: [{ runtimeId: 'runtime-1' }] })
    expect(sendRequest).toHaveBeenCalledWith('environmentRecipes.listRuntimes', {
      repoId: 'repo-1'
    })
  })

  it('replays a missing-ref provision with the same host idempotency key', async () => {
    const sendRequest = vi
      .fn()
      .mockRejectedValueOnce(markRpcDeliveryUnknown(new Error('connection closed')))
      .mockResolvedValueOnce(success(runtimeResult()))
    const args = {
      repoId: 'repo-1',
      recipeId: 'recipe-1',
      clientMutationId: 'provision-1'
    }

    await expect(
      provisionMobileEnvironmentRecipe({ sendRequest }, capabilities, args)
    ).resolves.toMatchObject({ runtimeId: 'runtime-1', connectionType: 'ssh' })
    expect(sendRequest).toHaveBeenCalledTimes(2)
    expect(sendRequest.mock.calls[0]?.[1]).toEqual(args)
    expect(sendRequest.mock.calls[1]?.[1]).toEqual(args)
    expect(sendRequest.mock.calls[0]?.[1]).not.toHaveProperty('ref')
  })

  it('rejects a response that leaks recipe result credentials', async () => {
    const sendRequest = vi.fn().mockResolvedValue(
      success({
        ...runtimeResult(),
        pairingCode: 'orca://pair?code=secret'
      })
    )

    await expect(
      provisionMobileEnvironmentRecipe({ sendRequest }, capabilities, {
        repoId: 'repo-1',
        recipeId: 'recipe-1',
        clientMutationId: 'provision-1'
      })
    ).rejects.toThrow()
  })
})
