import type { OrcaRuntimeService } from './runtime/orca-runtime'
import type { OrcaVmRecipe } from '../shared/orca-yaml-hook-types'
import {
  ENVIRONMENT_RECIPE_RPC_METHODS,
  toEnvironmentRecipeDescriptor,
  toEnvironmentRecipeRuntime,
  type EnvironmentRecipeListResult,
  type EnvironmentRecipeRuntimeListResult,
  type EnvironmentRecipeRuntime
} from '../shared/environment-recipe-runtime-rpc'
import { listEphemeralVmRuntimes } from '../shared/ephemeral-vm-runtime-store'
import { removeEnvironment } from '../shared/runtime-environment-store'
import {
  cleanupEphemeralVmRuntime,
  provisionEphemeralVmRuntime,
  resumeEphemeralVmRuntime,
  suspendEphemeralVmRuntime
} from './ephemeral-vm-runtime-service'
import { getProvisionedRootRecipeRepoUrl } from '../shared/ephemeral-vm-recipe-repo-url'
import {
  environmentRecipeMutationRuntimeId,
  EnvironmentRecipeRpcError,
  resetEnvironmentRecipeOperationControlForTests as resetRpcState,
  runIdempotentEnvironmentRecipeMutation,
  runSerializedEnvironmentRecipeRuntimeOperation as runRuntimeOperation
} from './environment-recipe-operation-control'
import {
  finalizeProvisionedEnvironmentRecipeRuntime,
  finalizeResumedEnvironmentRecipeRuntime
} from './environment-recipe-runtime-connection'
import {
  requireEnvironmentRecipe,
  requireEnvironmentRecipeRepo,
  requireEnvironmentRecipeRuntimeScope,
  resolveEnvironmentRecipeRuntimeScope,
  resolveEnvironmentRecipes,
  isRuntimeBoundToOperatorRecipe,
  type EnvironmentRecipeScope
} from './environment-recipe-scope'
import type { OperatorEnvironmentRecipeCatalog } from './operator-environment-recipe-catalog'
import { listEnvironmentRecipeRuntimes } from './environment-recipe-runtime-list'

export { EnvironmentRecipeRpcError } from './environment-recipe-operation-control'

export type EnvironmentRecipeProvisionParams = EnvironmentRecipeScope & {
  clientMutationId: string
  projectId?: string
  workspaceId?: string
  workspaceName?: string
  branch?: string
  ref?: string
}

export type EnvironmentRecipeLifecycleParams = EnvironmentRecipeScope & {
  runtimeId: string
  clientMutationId: string
}

export type EnvironmentRecipeRuntimeRpcDependencies = {
  runtime: Pick<OrcaRuntimeService, 'listRepos'>
  userDataPath: string
  pairedDeviceId: string
  getPluginRecipes: () => Promise<readonly OrcaVmRecipe[]>
  operatorRecipeCatalog?: OperatorEnvironmentRecipeCatalog
}

export async function listEnvironmentRecipesForRpc(
  deps: EnvironmentRecipeRuntimeRpcDependencies,
  repoId: string
): Promise<EnvironmentRecipeListResult> {
  const repo = requireEnvironmentRecipeRepo(deps.runtime, repoId)
  const recipes = await resolveEnvironmentRecipes(
    repo,
    deps.getPluginRecipes,
    deps.operatorRecipeCatalog
  )
  return {
    repoId,
    recipes: recipes.map((recipe) => toEnvironmentRecipeDescriptor(repoId, recipe))
  }
}

export function listEnvironmentRecipeRuntimesForRpc(
  deps: EnvironmentRecipeRuntimeRpcDependencies,
  repoId: string
): EnvironmentRecipeRuntimeListResult {
  return listEnvironmentRecipeRuntimes(deps, repoId)
}

export function provisionEnvironmentRecipeForRpc(
  deps: EnvironmentRecipeRuntimeRpcDependencies,
  params: EnvironmentRecipeProvisionParams
): Promise<EnvironmentRecipeRuntime> {
  return runIdempotentEnvironmentRecipeMutation(
    deps.userDataPath,
    deps.pairedDeviceId,
    ENVIRONMENT_RECIPE_RPC_METHODS.provision,
    params,
    async () => {
      const repo = requireEnvironmentRecipeRepo(deps.runtime, params.repoId)
      const runtimeId = environmentRecipeMutationRuntimeId(
        deps.userDataPath,
        deps.pairedDeviceId,
        params.clientMutationId
      )
      const existing = listEphemeralVmRuntimes(deps.userDataPath).find(
        (runtime) => runtime.id === runtimeId
      )
      if (existing?.operatorRecipeCatalogSha256 && !deps.operatorRecipeCatalog) {
        throw new EnvironmentRecipeRpcError(
          'environment_recipe_not_found',
          'Recipe-created runtime requires its operator catalog.'
        )
      }
      const recipe = await requireEnvironmentRecipe(
        repo,
        params.recipeId,
        deps.getPluginRecipes,
        deps.operatorRecipeCatalog
      )
      if (existing) {
        requireEnvironmentRecipeRuntimeScope(existing, params)
        if (
          deps.operatorRecipeCatalog &&
          !isRuntimeBoundToOperatorRecipe(
            existing,
            recipe,
            deps.operatorRecipeCatalog.status.digest
          )
        ) {
          throw new EnvironmentRecipeRpcError(
            'environment_recipe_not_found',
            'Recipe-created runtime is not bound to the active operator catalog.'
          )
        }
        if (existing.status === 'cleaned' || existing.status === 'cleanup_failed') {
          throw new EnvironmentRecipeRpcError(
            'environment_recipe_conflict',
            'This provision attempt was already cleaned up. Start a new attempt.'
          )
        }
        return finalizeProvisionedEnvironmentRecipeRuntime(deps, repo, recipe, existing)
      }

      const provisioned = await provisionEphemeralVmRuntime({
        userDataPath: deps.userDataPath,
        repoPath: repo.path,
        repoId: repo.id,
        recipe,
        runtimeId,
        repoUrl: getProvisionedRootRecipeRepoUrl(
          recipe.checkoutMode,
          repo.gitRemoteIdentity?.remoteUrl
        ),
        projectId: params.projectId,
        workspaceId: params.workspaceId,
        workspaceName: params.workspaceName,
        branch: params.branch,
        ref: params.ref,
        executionMode: deps.operatorRecipeCatalog ? 'direct' : 'shell',
        operatorRecipeCatalogSha256: deps.operatorRecipeCatalog?.status.digest
      })
      if (!provisioned.ok) {
        throw failedOperation('Provision', provisioned.start.error)
      }
      return finalizeProvisionedEnvironmentRecipeRuntime(deps, repo, recipe, provisioned.runtime)
    }
  )
}

export function suspendEnvironmentRecipeForRpc(
  deps: EnvironmentRecipeRuntimeRpcDependencies,
  params: EnvironmentRecipeLifecycleParams
): Promise<EnvironmentRecipeRuntime> {
  return runIdempotentEnvironmentRecipeMutation(
    deps.userDataPath,
    deps.pairedDeviceId,
    ENVIRONMENT_RECIPE_RPC_METHODS.suspend,
    params,
    () =>
      runRuntimeOperation(deps.userDataPath, params.runtimeId, async () => {
        const { repo, recipe, runtime } = await resolveEnvironmentRecipeRuntimeScope(deps, params)
        if (runtime.status === 'suspended' || runtime.status === 'resume_failed') {
          return toEnvironmentRecipeRuntime(runtime, recipe)
        }
        if (runtime.status !== 'running' && runtime.status !== 'suspend_failed') {
          throw invalidLifecycleState('suspend', runtime.status)
        }
        const suspended = await suspendEphemeralVmRuntime({
          userDataPath: deps.userDataPath,
          repoPath: repo.path,
          recipe,
          runtimeId: runtime.id,
          executionMode: deps.operatorRecipeCatalog ? 'direct' : 'shell',
          operatorRecipeCatalogSha256: deps.operatorRecipeCatalog?.status.digest
        })
        if (!suspended.ok) {
          throw failedOperation('Suspend', suspended.error)
        }
        if (runtime.connectionMode === 'ssh' && !suspended.skipped) {
          const { disconnectRuntimeOwnedSshTarget } = await import('./ephemeral-vm-runtime-ssh')
          await disconnectRuntimeOwnedSshTarget(runtime.sshTargetId).catch(() => undefined)
        }
        return toEnvironmentRecipeRuntime(suspended.runtime, recipe)
      })
  )
}

export function resumeEnvironmentRecipeForRpc(
  deps: EnvironmentRecipeRuntimeRpcDependencies,
  params: EnvironmentRecipeLifecycleParams
): Promise<EnvironmentRecipeRuntime> {
  return runIdempotentEnvironmentRecipeMutation(
    deps.userDataPath,
    deps.pairedDeviceId,
    ENVIRONMENT_RECIPE_RPC_METHODS.resume,
    params,
    () =>
      runRuntimeOperation(deps.userDataPath, params.runtimeId, async () => {
        const { repo, recipe, runtime } = await resolveEnvironmentRecipeRuntimeScope(deps, params)
        if (runtime.status === 'running' || runtime.status === 'suspend_failed') {
          return toEnvironmentRecipeRuntime(runtime, recipe)
        }
        if (runtime.status !== 'suspended' && runtime.status !== 'resume_failed') {
          throw invalidLifecycleState('resume', runtime.status)
        }
        const resumed = await resumeEphemeralVmRuntime({
          userDataPath: deps.userDataPath,
          repoPath: repo.path,
          recipe,
          runtimeId: runtime.id,
          executionMode: deps.operatorRecipeCatalog ? 'direct' : 'shell',
          operatorRecipeCatalogSha256: deps.operatorRecipeCatalog?.status.digest
        })
        if (!resumed.ok) {
          throw failedOperation('Resume', resumed.error)
        }
        if (resumed.skipped) {
          return toEnvironmentRecipeRuntime(resumed.runtime, recipe)
        }
        return finalizeResumedEnvironmentRecipeRuntime(deps, recipe, resumed.runtime)
      })
  )
}

export function destroyEnvironmentRecipeForRpc(
  deps: EnvironmentRecipeRuntimeRpcDependencies,
  params: EnvironmentRecipeLifecycleParams
): Promise<EnvironmentRecipeRuntime> {
  return runIdempotentEnvironmentRecipeMutation(
    deps.userDataPath,
    deps.pairedDeviceId,
    ENVIRONMENT_RECIPE_RPC_METHODS.destroy,
    params,
    () =>
      runRuntimeOperation(deps.userDataPath, params.runtimeId, async () => {
        const { repo, recipe, runtime } = await resolveEnvironmentRecipeRuntimeScope(deps, params)
        if (runtime.status === 'cleaned' && !runtime.sshTargetId) {
          return toEnvironmentRecipeRuntime(runtime, recipe)
        }
        const cleanup = await cleanupEphemeralVmRuntime({
          userDataPath: deps.userDataPath,
          repoPath: repo.path,
          recipe,
          runtimeId: runtime.id,
          executionMode: deps.operatorRecipeCatalog ? 'direct' : 'shell',
          operatorRecipeCatalogSha256: deps.operatorRecipeCatalog?.status.digest
        })
        if (cleanup.ok && runtime.runtimeEnvironmentId) {
          try {
            removeEnvironment(deps.userDataPath, runtime.runtimeEnvironmentId)
          } catch {
            // Provider cleanup is authoritative; a stale environment row is removable later.
          }
        }
        const [{ removeEphemeralVmRuntimeSshTarget }, { removeRuntimeOwnedSshTarget }] =
          await Promise.all([
            import('./ephemeral-vm-runtime-ssh-cleanup'),
            import('./ephemeral-vm-runtime-ssh')
          ])
        const withoutSsh = await removeEphemeralVmRuntimeSshTarget({
          userDataPath: deps.userDataPath,
          runtime: cleanup.runtime,
          removeTarget: removeRuntimeOwnedSshTarget
        })
        if (!cleanup.ok) {
          throw failedOperation('Destroy', cleanup.error)
        }
        return toEnvironmentRecipeRuntime(withoutSsh, recipe)
      })
  )
}

export const resetEnvironmentRecipeRpcStateForTests = resetRpcState

function invalidLifecycleState(action: string, status: string): EnvironmentRecipeRpcError {
  return new EnvironmentRecipeRpcError(
    'environment_recipe_conflict',
    `Cannot ${action} a recipe-created runtime in '${status}' state.`
  )
}

function failedOperation(action: string, _error: unknown): EnvironmentRecipeRpcError {
  return new EnvironmentRecipeRpcError(
    'environment_recipe_failed',
    `${action} failed on the runtime host.`
  )
}
