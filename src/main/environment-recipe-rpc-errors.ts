import { EnvironmentRecipeRpcError } from './environment-recipe-operation-control'

export function invalidLifecycleState(action: string, status: string): EnvironmentRecipeRpcError {
  return new EnvironmentRecipeRpcError(
    'environment_recipe_conflict',
    `Cannot ${action} a recipe-created runtime in '${status}' state.`
  )
}

export function failedOperation(action: string, _error: unknown): EnvironmentRecipeRpcError {
  return new EnvironmentRecipeRpcError(
    'environment_recipe_failed',
    `${action} failed on the runtime host.`
  )
}
