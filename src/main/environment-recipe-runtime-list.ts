import type { OrcaRuntimeService } from './runtime/orca-runtime'
import type { OperatorEnvironmentRecipeCatalog } from './operator-environment-recipe-catalog'
import {
  requireEnvironmentRecipeRepo,
  isRuntimeBoundToOperatorRecipe
} from './environment-recipe-scope'
import { listEphemeralVmRuntimes } from '../shared/ephemeral-vm-runtime-store'
import {
  toEnvironmentRecipeRuntime,
  type EnvironmentRecipeRuntimeListResult
} from '../shared/environment-recipe-runtime-rpc'

type RuntimeListContext = {
  runtime: Pick<OrcaRuntimeService, 'listRepos'>
  userDataPath: string
  operatorRecipeCatalog?: OperatorEnvironmentRecipeCatalog
}

export function listEnvironmentRecipeRuntimes(
  context: RuntimeListContext,
  repoId: string
): EnvironmentRecipeRuntimeListResult {
  requireEnvironmentRecipeRepo(context.runtime, repoId)
  const catalog = context.operatorRecipeCatalog
  const catalogDigest = catalog?.status.digest
  const operatorRecipes = catalog
    ? new Map(catalog.listRecipes().map((recipe) => [recipe.id, recipe]))
    : null
  const runtimes = listEphemeralVmRuntimes(context.userDataPath)
    .filter((runtime) => runtime.repoId === repoId && runtime.status !== 'cleaned')
    .filter((runtime) => {
      if (!operatorRecipes) {
        return !runtime.operatorRecipeCatalogSha256
      }
      const recipe = operatorRecipes.get(runtime.recipeId)
      return recipe && catalogDigest
        ? isRuntimeBoundToOperatorRecipe(runtime, recipe, catalogDigest)
        : false
    })
    .sort(
      (left, right) =>
        right.updatedAt - left.updatedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    )
    .slice(0, 100)
    .map((runtime) =>
      toEnvironmentRecipeRuntime(runtime, operatorRecipes?.get(runtime.recipeId) ?? runtime.recipe)
    )
  return { repoId, runtimes }
}
