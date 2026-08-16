import { describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../transport/types'
import {
  ENVIRONMENT_RECIPE_LIFECYCLE_RUNTIME_CAPABILITY,
  ENVIRONMENT_RECIPE_MANAGEMENT_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import {
  adoptMobileEnvironmentWorkspace,
  loadMobileEnvironmentRecipeCapabilities
} from './environment-workspace-adoption'

function success(result: unknown): RpcResponse {
  return { id: 'rpc-1', ok: true, result, _meta: { runtimeId: 'host-1' } }
}

describe('mobile environment workspace adoption', () => {
  const capabilities = [
    ENVIRONMENT_RECIPE_LIFECYCLE_RUNTIME_CAPABILITY,
    ENVIRONMENT_RECIPE_MANAGEMENT_RUNTIME_CAPABILITY
  ]
  it('cuts over to the host-owned SSH root with a stable adoption key', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce(
        success({
          result: {
            repo: { id: 'adopted-repo' },
            project: {},
            setup: {}
          }
        })
      )
      .mockResolvedValueOnce(success({ worktree: { id: 'worktree-1' } }))
    const runtime = {
      runtimeId: 'runtime-1',
      repoId: 'repo-1',
      recipeId: 'recipe-1',
      workspaceName: 'Cloud box',
      checkoutMode: 'provisioned-root' as const,
      status: 'running' as const,
      lifecycle: { suspend: true, resume: true, destroy: true },
      createdAt: 1,
      updatedAt: 2,
      connectionType: 'ssh' as const,
      projectRoot: '/srv/repo',
      adoption: {
        runtimeId: 'runtime-1',
        sourceRepoId: 'repo-1',
        connectionId: 'runtime-ssh-runtime-1',
        executionHostId: 'ssh:runtime-ssh-runtime-1' as const,
        expectedPath: '/srv/repo'
      }
    }
    const projects = [
      {
        id: 'project-1',
        displayName: 'Project',
        badgeColor: '#000',
        sourceRepoIds: ['repo-1'],
        createdAt: 1,
        updatedAt: 1
      }
    ]

    await expect(
      adoptMobileEnvironmentWorkspace({ sendRequest } as never, capabilities, runtime, projects)
    ).resolves.toEqual({ id: 'worktree-1', name: 'Cloud box' })
    expect(sendRequest.mock.calls[1]?.[1]).toMatchObject({
      clientMutationId: 'environment-runtime-adopt:runtime-1',
      provisionedRoot: { runtimeId: 'runtime-1', sourceRepoId: 'repo-1' }
    })
  })

  it('does not mutate a lifecycle-only host during adoption', async () => {
    const sendRequest = vi.fn()

    await expect(
      adoptMobileEnvironmentWorkspace(
        { sendRequest } as never,
        [ENVIRONMENT_RECIPE_LIFECYCLE_RUNTIME_CAPABILITY],
        {} as never,
        []
      )
    ).rejects.toThrow('Update Orca on this host')
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('rejects mismatched or ambiguous source identity before setup mutation', async () => {
    const sendRequest = vi.fn()
    const runtime = {
      status: 'running',
      connectionType: 'ssh',
      repoId: 'repo-1',
      adoption: {
        sourceRepoId: 'other-repo',
        executionHostId: 'ssh:runtime-ssh-runtime-1',
        expectedPath: '/srv/repo'
      }
    }

    await expect(
      adoptMobileEnvironmentWorkspace({ sendRequest } as never, capabilities, runtime as never, [])
    ).rejects.toThrow('adoption_identity_mismatch')
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('treats a host without capability metadata as unsupported', async () => {
    const sendRequest = vi.fn().mockResolvedValue(success({ runtimeId: 'old-host' }))
    await expect(
      loadMobileEnvironmentRecipeCapabilities({ sendRequest } as never)
    ).resolves.toEqual([])
  })
})
