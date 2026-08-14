import type { OrcaVmRecipe } from '../shared/orca-yaml-hook-types'
import { upsertEphemeralVmRuntime } from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import { getEphemeralVmRecipeResultConnection } from '../shared/ephemeral-vm-recipes'
import {
  runEphemeralVmRecipeCleanup,
  type EphemeralVmRecipeStartSuccess
} from './ephemeral-vm-recipe-runner'

type ProvisionedRuntimeRecordingArgs = {
  userDataPath: string
  repoPath: string
  recipe: OrcaVmRecipe
  repoId?: string
  projectId?: string
  workspaceId?: string
  workspaceName?: string
}

export async function recordProvisionedEphemeralVmRuntime(
  args: ProvisionedRuntimeRecordingArgs,
  start: EphemeralVmRecipeStartSuccess,
  now: number
): Promise<EphemeralVmRuntimeRecord> {
  const connection = getEphemeralVmRecipeResultConnection(start.result)
  try {
    return upsertEphemeralVmRuntime(args.userDataPath, {
      id: start.context.instanceId ?? start.context.recipeId,
      recipeId: args.recipe.id,
      recipe: args.recipe,
      ...(args.repoId ? { repoId: args.repoId } : {}),
      ...(args.projectId ? { projectId: args.projectId } : {}),
      ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
      ...(args.workspaceName ? { workspaceName: args.workspaceName } : {}),
      status: 'running',
      connectionMode: connection.type,
      cleanupStatus: args.recipe.destroyDisabled ? 'disabled' : 'not_started',
      ...(args.recipe.destroyDisabled ? { cleanupDisabled: true } : {}),
      createdAt: now,
      updatedAt: now,
      recipeResult: start.result
    })
  } catch (error) {
    await runEphemeralVmRecipeCleanup({
      repoPath: args.repoPath,
      recipe: args.recipe,
      context: start.context,
      recipeResult: start.result
    }).catch(() => undefined)
    throw error
  }
}
