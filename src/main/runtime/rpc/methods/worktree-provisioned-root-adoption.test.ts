import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { adoptProvisionedRootFromRpc } from './worktree-provisioned-root-adoption'
import { WorktreeCreate } from './worktree-schemas'

describe('provisioned-root worktree RPC adoption', () => {
  it('passes only bounded adoption metadata to the host runtime', async () => {
    const runtime = {
      adoptManagedProvisionedRoot: vi.fn().mockResolvedValue({ worktree: { id: 'wt-1' } })
    } as unknown as OrcaRuntimeService
    const params = WorktreeCreate.parse({
      repo: 'id:repo-1',
      name: 'Cloud box',
      activate: true,
      clientMutationId: 'adopt-1',
      provisionedRoot: {
        runtimeId: 'runtime-1',
        sourceRepoId: 'source-repo-1',
        executionHostId: 'ssh:runtime-ssh-runtime-1',
        expectedPath: '/srv/repo'
      }
    })

    await expect(adoptProvisionedRootFromRpc(runtime, params, '/profile-a')).resolves.toMatchObject(
      {
        worktree: { id: 'wt-1' }
      }
    )
    expect(runtime.adoptManagedProvisionedRoot).toHaveBeenCalledWith({
      repoId: 'repo-1',
      userDataPath: '/profile-a',
      activate: true,
      request: expect.objectContaining({
        runtimeId: 'runtime-1',
        sourceRepoId: 'source-repo-1',
        executionHostId: 'ssh:runtime-ssh-runtime-1',
        expectedPath: '/srv/repo'
      })
    })
  })

  it('leaves ordinary worktree creation unchanged', () => {
    const runtime = { adoptManagedProvisionedRoot: vi.fn() } as unknown as OrcaRuntimeService
    const params = WorktreeCreate.parse({ repo: 'id:repo-1', name: 'feature' })

    expect(adoptProvisionedRootFromRpc(runtime, params)).toBeNull()
    expect(runtime.adoptManagedProvisionedRoot).not.toHaveBeenCalled()
  })
})
