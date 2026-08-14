import type { WorktreeCreationRequest } from './pending-worktree-creation'

export type ProvisionedRootCreateOptions = {
  runtimeId: string
  sourceRepoId: string
  executionHostId: NonNullable<WorktreeCreationRequest['workspaceRunContext']>['hostId']
  expectedPath: string
}

export function getProvisionedRootCreateOptions(
  request: WorktreeCreationRequest
): ProvisionedRootCreateOptions | null {
  if (request.ephemeralVmCheckoutMode !== 'provisioned-root') {
    return null
  }
  if (!request.ephemeralVmRuntimeId || !request.workspaceRunContext || !request.ephemeralVmRecipe) {
    throw new Error('Provisioned-root workspace identity is incomplete.')
  }
  return {
    runtimeId: request.ephemeralVmRuntimeId,
    sourceRepoId: request.ephemeralVmRecipe.sourceRepoId,
    executionHostId: request.workspaceRunContext.hostId,
    expectedPath: request.workspaceRunContext.path
  }
}
