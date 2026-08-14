import { describe, expect, it, vi } from 'vitest'
import { ENVIRONMENT_RECIPE_LIFECYCLE_RUNTIME_CAPABILITY } from './protocol-version'
import {
  listEnvironmentRecipeRuntimes,
  provisionEnvironmentRecipe
} from './environment-recipe-client'

const capabilities = [ENVIRONMENT_RECIPE_LIFECYCLE_RUNTIME_CAPABILITY]
const runtime = {
  runtimeId: 'runtime-1',
  repoId: 'repo-1',
  recipeId: 'recipe-1',
  checkoutMode: 'provisioned-root' as const,
  status: 'running' as const,
  lifecycle: { suspend: true, resume: true, destroy: true },
  createdAt: 1,
  updatedAt: 2,
  connectionType: 'ssh' as const,
  projectRoot: '/srv/repo'
}

describe('shared environment recipe client', () => {
  it('does not call runtime discovery on an old host', async () => {
    const request = vi.fn()
    await expect(listEnvironmentRecipeRuntimes(request, [], 'repo-1')).rejects.toThrow(
      'Update Orca on this host'
    )
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps the mutation key stable across ambiguous delivery retries', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('cutover'))
      .mockResolvedValueOnce(runtime)
    const args = {
      repoId: 'repo-1',
      recipeId: 'recipe-1',
      clientMutationId: 'durable-1'
    }

    await expect(
      provisionEnvironmentRecipe(request, capabilities, args, () => true)
    ).resolves.toMatchObject({ runtimeId: 'runtime-1' })
    expect(request.mock.calls.map((call) => call[1])).toEqual([args, args])
  })

  it('redacts unclassified host errors', async () => {
    const request = vi.fn().mockRejectedValue(new Error('provider token=secret'))
    await expect(
      provisionEnvironmentRecipe(
        request,
        capabilities,
        { repoId: 'repo-1', recipeId: 'recipe-1', clientMutationId: 'durable-1' },
        () => false
      )
    ).rejects.toThrow('Environment workspace operation failed on the runtime host.')
  })
})
