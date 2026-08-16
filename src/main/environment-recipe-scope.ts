import type { OrcaRuntimeService } from './runtime/orca-runtime'
import type { OrcaVmRecipe } from '../shared/orca-yaml-hook-types'
import type { Repo } from '../shared/repo-types'
import { isFolderRepo } from '../shared/repo-kind'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'
import { listEphemeralVmRuntimes } from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import { loadHooks } from './hooks'
import { combineEphemeralVmRecipes } from './ipc/ephemeral-vm-recipe-context'
import { EnvironmentRecipeRpcError } from './environment-recipe-operation-control'
import type { OperatorEnvironmentRecipeCatalog } from './operator-environment-recipe-catalog'

export type EnvironmentRecipeScope = {
  repoId: string
  recipeId: string
}

type EnvironmentRecipeCatalogContext = {
  runtime: Pick<OrcaRuntimeService, 'listRepos'>
  userDataPath: string
  getPluginRecipes: () => Promise<readonly OrcaVmRecipe[]>
  operatorRecipeCatalog?: OperatorEnvironmentRecipeCatalog
}

export function requireEnvironmentRecipeRepo(
  runtime: Pick<OrcaRuntimeService, 'listRepos'>,
  repoId: string
): Repo {
  const repo = runtime.listRepos().find((candidate) => candidate.id === repoId)
  if (!repo || isFolderRepo(repo) || getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
    throw new EnvironmentRecipeRpcError(
      'environment_recipe_not_found',
      'Eligible recipe repository not found on this runtime host.'
    )
  }
  return repo
}

export async function resolveEnvironmentRecipes(
  repo: Repo,
  getPluginRecipes: () => Promise<readonly OrcaVmRecipe[]>,
  operatorRecipeCatalog?: OperatorEnvironmentRecipeCatalog
): Promise<OrcaVmRecipe[]> {
  if (operatorRecipeCatalog) {
    return [...operatorRecipeCatalog.listRecipes()]
  }
  const pluginRecipes = await getPluginRecipes()
  return combineEphemeralVmRecipes(loadHooks(repo.path)?.environmentRecipes ?? [], pluginRecipes)
}

export async function requireEnvironmentRecipe(
  repo: Repo,
  recipeId: string,
  getPluginRecipes: () => Promise<readonly OrcaVmRecipe[]>,
  operatorRecipeCatalog?: OperatorEnvironmentRecipeCatalog
): Promise<OrcaVmRecipe> {
  const recipe = (
    await resolveEnvironmentRecipes(repo, getPluginRecipes, operatorRecipeCatalog)
  ).find((candidate) => candidate.id === recipeId)
  if (!recipe) {
    throw new EnvironmentRecipeRpcError(
      'environment_recipe_not_found',
      'Eligible environment recipe not found in this repository.'
    )
  }
  return recipe
}

export async function resolveEnvironmentRecipeRuntimeScope(
  context: EnvironmentRecipeCatalogContext,
  scope: EnvironmentRecipeScope & { runtimeId: string }
): Promise<{ repo: Repo; recipe: OrcaVmRecipe; runtime: EphemeralVmRuntimeRecord }> {
  const runtime = listEphemeralVmRuntimes(context.userDataPath).find(
    (candidate) => candidate.id === scope.runtimeId
  )
  if (!runtime) {
    throw new EnvironmentRecipeRpcError(
      'environment_recipe_not_found',
      'Recipe-created runtime not found.'
    )
  }
  requireEnvironmentRecipeRuntimeScope(runtime, scope)
  const repo = requireEnvironmentRecipeRepo(context.runtime, scope.repoId)
  if (!context.operatorRecipeCatalog && runtime.operatorRecipeCatalogSha256) {
    throw new EnvironmentRecipeRpcError(
      'environment_recipe_not_found',
      'Recipe-created runtime requires its operator catalog.'
    )
  }
  const operatorRecipe = context.operatorRecipeCatalog?.resolveRecipe(scope.recipeId)
  if (context.operatorRecipeCatalog && !operatorRecipe) {
    throw new EnvironmentRecipeRpcError(
      'environment_recipe_not_found',
      'Eligible environment recipe not found in the operator catalog.'
    )
  }
  const recipe =
    operatorRecipe ??
    runtime.recipe ??
    (await requireEnvironmentRecipe(repo, scope.recipeId, context.getPluginRecipes))
  if (
    context.operatorRecipeCatalog &&
    !isRuntimeBoundToOperatorRecipe(runtime, recipe, context.operatorRecipeCatalog.status.digest)
  ) {
    throw new EnvironmentRecipeRpcError(
      'environment_recipe_not_found',
      'Recipe-created runtime is not bound to the active operator catalog.'
    )
  }
  return { repo, recipe, runtime }
}

export function isRuntimeBoundToOperatorRecipe(
  runtime: EphemeralVmRuntimeRecord,
  recipe: OrcaVmRecipe,
  catalogSha256: string
): boolean {
  return Boolean(
    runtime.operatorRecipeCatalogSha256 === catalogSha256 &&
    runtime.recipe?.checkoutMode === 'provisioned-root' &&
    runtime.recipe.id === recipe.id &&
    runtime.recipe.create === recipe.create &&
    runtime.recipe.suspend === recipe.suspend &&
    runtime.recipe.resume === recipe.resume &&
    runtime.recipe.destroy === recipe.destroy
  )
}

export function requireEnvironmentRecipeRuntimeScope(
  runtime: EphemeralVmRuntimeRecord,
  scope: EnvironmentRecipeScope
): void {
  if (runtime.repoId !== scope.repoId || runtime.recipeId !== scope.recipeId) {
    throw new EnvironmentRecipeRpcError(
      'environment_recipe_not_found',
      'Recipe-created runtime not found in this repository and recipe scope.'
    )
  }
}
