import type { z } from 'zod'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { WorktreeCreate } from './worktree-schemas'

export function adoptProvisionedRootFromRpc(
  runtime: OrcaRuntimeService,
  params: z.infer<typeof WorktreeCreate>,
  userDataPath?: string
) {
  if (!params.provisionedRoot) {
    return null
  }
  if (!userDataPath) {
    throw new Error('Provisioned-root adoption storage is unavailable.')
  }
  const repoId = params.repo.startsWith('id:') ? params.repo.slice(3) : params.repo
  return runtime.adoptManagedProvisionedRoot({
    repoId,
    userDataPath,
    request: {
      repoId,
      name: params.name ?? '',
      runtimeId: params.provisionedRoot.runtimeId,
      sourceRepoId: params.provisionedRoot.sourceRepoId,
      executionHostId: params.provisionedRoot.executionHostId as ExecutionHostId,
      expectedPath: params.provisionedRoot.expectedPath,
      ...(params.displayName ? { displayName: params.displayName } : {}),
      ...(params.baseBranch ? { baseBranch: params.baseBranch } : {}),
      ...(params.compareBaseRef ? { compareBaseRef: params.compareBaseRef } : {})
    },
    activate: params.activate === true
  })
}
