import { describe, expect, it, vi } from 'vitest'
import {
  ENVIRONMENT_RECIPE_LIFECYCLE_RUNTIME_CAPABILITY,
  ENVIRONMENT_RECIPE_MANAGEMENT_RUNTIME_CAPABILITY
} from './protocol-version'
import {
  listEnvironmentRecipes,
  listEnvironmentRecipeRuntimes,
  provisionEnvironmentRecipe
} from './environment-recipe-client'

const capabilities = [ENVIRONMENT_RECIPE_LIFECYCLE_RUNTIME_CAPABILITY]
const managementCapabilities = [
  ENVIRONMENT_RECIPE_LIFECYCLE_RUNTIME_CAPABILITY,
  ENVIRONMENT_RECIPE_MANAGEMENT_RUNTIME_CAPABILITY
]
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

  it('keeps lifecycle-only hosts on the original methods', async () => {
    const request = vi.fn().mockResolvedValue({ repoId: 'repo-1', recipes: [] })

    await expect(listEnvironmentRecipes(request, capabilities, 'repo-1')).resolves.toEqual({
      repoId: 'repo-1',
      recipes: []
    })
    await expect(listEnvironmentRecipeRuntimes(request, capabilities, 'repo-1')).rejects.toThrow(
      'Update Orca on this host'
    )
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('allows runtime discovery only when both capabilities are advertised', async () => {
    const request = vi.fn().mockResolvedValue({ repoId: 'repo-1', runtimes: [] })

    await expect(
      listEnvironmentRecipeRuntimes(request, managementCapabilities, 'repo-1')
    ).resolves.toEqual({ repoId: 'repo-1', runtimes: [] })
  })

  it('keeps a missing-ref desktop mutation stable across ambiguous delivery retries', async () => {
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
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty('ref')
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
