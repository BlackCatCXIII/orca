import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ENVIRONMENT_RECIPE_RPC_METHODS } from '../../../../shared/environment-recipe-runtime-rpc'
import type { RpcMethod } from '../core'

const serviceMocks = vi.hoisted(() => ({
  list: vi.fn(),
  provision: vi.fn(),
  suspend: vi.fn(),
  resume: vi.fn(),
  destroy: vi.fn()
}))

vi.mock('../../../environment-recipe-runtime-rpc-service', () => ({
  listEnvironmentRecipesForRpc: serviceMocks.list,
  provisionEnvironmentRecipeForRpc: serviceMocks.provision,
  suspendEnvironmentRecipeForRpc: serviceMocks.suspend,
  resumeEnvironmentRecipeForRpc: serviceMocks.resume,
  destroyEnvironmentRecipeForRpc: serviceMocks.destroy
}))

import { ENVIRONMENT_RECIPE_METHODS } from './environment-recipes'

function method(name: string): RpcMethod {
  const found = ENVIRONMENT_RECIPE_METHODS.find((candidate) => candidate.name === name)
  if (!found) {
    throw new Error(`Missing method: ${name}`)
  }
  return found
}

describe('environment recipe RPC authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('requires the authenticated paired-device context before reading host recipes', async () => {
    const handler = method(ENVIRONMENT_RECIPE_RPC_METHODS.list).handler

    expect(() =>
      handler(
        { repoId: 'repo-1' },
        {
          runtime: { listRepos: () => [] } as never,
          userDataPath: '/host-owned-data'
        }
      )
    ).toThrow('authenticated paired device')
  })

  it('keeps admitted host mutations independent of transport aborts for cutover replay', async () => {
    const controller = new AbortController()
    controller.abort()
    serviceMocks.provision.mockResolvedValue({ runtimeId: 'runtime-1' })

    await method(ENVIRONMENT_RECIPE_RPC_METHODS.provision).handler(
      {
        repoId: 'repo-1',
        recipeId: 'recipe-1',
        clientMutationId: 'provision-1'
      },
      {
        runtime: { listRepos: () => [] } as never,
        userDataPath: '/host-owned-data',
        pairedDeviceId: 'paired-device',
        signal: controller.signal
      }
    )

    expect(serviceMocks.provision).toHaveBeenCalledOnce()
    expect(serviceMocks.provision.mock.calls[0]?.[0]).not.toHaveProperty('signal')
  })
})
