import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import type { EphemeralVmRecipeContext } from './ephemeral-vm-recipe-runner'

export function ephemeralVmRecipeContextFromRuntime(
  repoPath: string,
  runtime: EphemeralVmRuntimeRecord
): EphemeralVmRecipeContext {
  return {
    instanceId: runtime.id,
    recipeId: runtime.recipeId,
    projectId: runtime.projectId,
    workspaceId: runtime.workspaceId,
    workspaceName: runtime.workspaceName,
    repoPath
  }
}
