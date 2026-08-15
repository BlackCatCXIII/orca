import {
  getEphemeralVmRecipeResultConnection,
  type EphemeralVmRecipeResult
} from '../shared/ephemeral-vm-recipes'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import {
  upsertEphemeralVmRuntime,
  upsertEphemeralVmRuntimeRollbackRecovery
} from '../shared/ephemeral-vm-runtime-store'
import type { ProvisionEphemeralVmRuntimeArgs } from './ephemeral-vm-runtime-service'
import {
  runEphemeralVmRecipeCleanup,
  type EphemeralVmRecipeContext
} from './ephemeral-vm-recipe-runner'

type FailedStart = {
  context: EphemeralVmRecipeContext
  recipeResult: EphemeralVmRecipeResult
}

export async function cleanupFailedEphemeralVmStart(
  args: ProvisionEphemeralVmRuntimeArgs,
  start: FailedStart
): Promise<boolean> {
  const cleanupError = await getCleanupError(args, start)
  if (cleanupError === null && !args.provisionMutation) {
    return true
  }
  const now = args.now ?? Date.now()
  const connection = getEphemeralVmRecipeResultConnection(start.recipeResult)
  const recovery: EphemeralVmRuntimeRecord = {
    id: start.context.instanceId ?? start.context.recipeId,
    recipeId: args.recipe.id,
    recipe: args.recipe,
    ...(args.operatorRecipeCatalogSha256
      ? { operatorRecipeCatalogSha256: args.operatorRecipeCatalogSha256 }
      : {}),
    ...(args.provisionMutation ? { provisionMutation: args.provisionMutation } : {}),
    ...(args.repoId ? { repoId: args.repoId } : {}),
    ...(args.projectId ? { projectId: args.projectId } : {}),
    ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
    ...(args.workspaceName ? { workspaceName: args.workspaceName } : {}),
    status: cleanupError === null ? 'cleaned' : 'cleanup_failed',
    connectionMode: connection.type,
    cleanupStatus:
      cleanupError === null ? 'succeeded' : args.recipe.destroyDisabled ? 'disabled' : 'failed',
    ...(args.recipe.destroyDisabled ? { cleanupDisabled: true } : {}),
    cleanupLastAttemptAt: now,
    ...(cleanupError ? { cleanupLastError: cleanupError } : {}),
    createdAt: now,
    updatedAt: now,
    recipeResult: start.recipeResult
  }
  try {
    upsertEphemeralVmRuntime(args.userDataPath, recovery)
  } catch (error) {
    if (!args.recipe.checkoutMode) {
      throw error
    }
    // Why: cleanup retry metadata must survive even when its feature companion is unreadable.
    upsertEphemeralVmRuntimeRollbackRecovery(args.userDataPath, recovery)
  }
  return false
}

async function getCleanupError(
  args: ProvisionEphemeralVmRuntimeArgs,
  start: FailedStart
): Promise<string | null> {
  try {
    const cleanup = await runEphemeralVmRecipeCleanup({
      repoPath: args.repoPath,
      recipe: args.recipe,
      executionMode: args.executionMode,
      context: start.context,
      recipeResult: start.recipeResult,
      signal: args.signal,
      onStdout: args.onStdout,
      onStderr: args.onStderr
    })
    if (cleanup.ok && !cleanup.skipped) {
      return null
    }
    return cleanup.ok
      ? 'Destroy is disabled for this recipe.'
      : (cleanup.error ?? 'Destroy failed.')
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
