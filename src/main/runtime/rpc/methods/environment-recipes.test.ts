import { describe, expect, it } from 'vitest'
import { ENVIRONMENT_RECIPE_RPC_METHODS } from '../../../../shared/environment-recipe-runtime-rpc'
import type { RpcMethod } from '../core'
import { ENVIRONMENT_RECIPE_METHODS } from './environment-recipes'

function method(name: string): RpcMethod {
  const found = ENVIRONMENT_RECIPE_METHODS.find((candidate) => candidate.name === name)
  if (!found) {
    throw new Error(`Missing method: ${name}`)
  }
  return found
}

describe('environment recipe RPC authorization', () => {
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
})
