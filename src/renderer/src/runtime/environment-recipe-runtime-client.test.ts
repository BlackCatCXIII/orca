import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ENVIRONMENT_RECIPE_LIFECYCLE_RUNTIME_CAPABILITY,
  ENVIRONMENT_RECIPE_MANAGEMENT_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'

const runtimeMocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  call: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  getRuntimeEnvironmentStatus: runtimeMocks.getStatus,
  callRuntimeRpc: runtimeMocks.call
}))

import { desktopSupportsEnvironmentRecipeManagement } from './environment-recipe-runtime-client'

describe('desktop environment recipe mixed-version gating', () => {
  beforeEach(() => vi.clearAllMocks())

  it('requires lifecycle and management capabilities together', async () => {
    runtimeMocks.getStatus.mockResolvedValueOnce({
      capabilities: [ENVIRONMENT_RECIPE_LIFECYCLE_RUNTIME_CAPABILITY]
    })
    await expect(desktopSupportsEnvironmentRecipeManagement('old-host')).resolves.toBe(false)

    runtimeMocks.getStatus.mockResolvedValueOnce({
      capabilities: [
        ENVIRONMENT_RECIPE_LIFECYCLE_RUNTIME_CAPABILITY,
        ENVIRONMENT_RECIPE_MANAGEMENT_RUNTIME_CAPABILITY
      ]
    })
    await expect(desktopSupportsEnvironmentRecipeManagement('new-host')).resolves.toBe(true)
    expect(runtimeMocks.call).not.toHaveBeenCalled()
  })
})
