import {
  destroyEnvironmentRecipe,
  listEnvironmentRecipeRuntimes,
  listEnvironmentRecipes,
  provisionEnvironmentRecipe,
  resumeEnvironmentRecipe,
  supportsEnvironmentRecipeLifecycle,
  suspendEnvironmentRecipe,
  type EnvironmentRecipeLifecycleArgs,
  type EnvironmentRecipeProvisionArgs,
  type EnvironmentRecipeRequest
} from '../../../src/shared/environment-recipe-client'
import type {
  EnvironmentRecipeListResult,
  EnvironmentRecipeRuntime,
  EnvironmentRecipeRuntimeListResult
} from '../../../src/shared/environment-recipe-runtime-rpc'
import type { RpcClient } from '../transport/rpc-client'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'

export type MobileEnvironmentRecipeProvisionArgs = EnvironmentRecipeProvisionArgs
export type MobileEnvironmentRecipeLifecycleArgs = EnvironmentRecipeLifecycleArgs

export { supportsEnvironmentRecipeLifecycle }

export function listMobileEnvironmentRecipes(
  client: Pick<RpcClient, 'sendRequest'>,
  capabilities: readonly string[],
  repoId: string
): Promise<EnvironmentRecipeListResult> {
  return listEnvironmentRecipes(mobileRequest(client), capabilities, repoId)
}

export function listMobileEnvironmentRecipeRuntimes(
  client: Pick<RpcClient, 'sendRequest'>,
  capabilities: readonly string[],
  repoId: string
): Promise<EnvironmentRecipeRuntimeListResult> {
  return listEnvironmentRecipeRuntimes(mobileRequest(client), capabilities, repoId)
}

export function provisionMobileEnvironmentRecipe(
  client: Pick<RpcClient, 'sendRequest'>,
  capabilities: readonly string[],
  args: MobileEnvironmentRecipeProvisionArgs
): Promise<EnvironmentRecipeRuntime> {
  return provisionEnvironmentRecipe(mobileRequest(client), capabilities, args, isAmbiguous)
}

export function suspendMobileEnvironmentRecipe(
  client: Pick<RpcClient, 'sendRequest'>,
  capabilities: readonly string[],
  args: MobileEnvironmentRecipeLifecycleArgs
): Promise<EnvironmentRecipeRuntime> {
  return suspendEnvironmentRecipe(mobileRequest(client), capabilities, args, isAmbiguous)
}

export function resumeMobileEnvironmentRecipe(
  client: Pick<RpcClient, 'sendRequest'>,
  capabilities: readonly string[],
  args: MobileEnvironmentRecipeLifecycleArgs
): Promise<EnvironmentRecipeRuntime> {
  return resumeEnvironmentRecipe(mobileRequest(client), capabilities, args, isAmbiguous)
}

export function destroyMobileEnvironmentRecipe(
  client: Pick<RpcClient, 'sendRequest'>,
  capabilities: readonly string[],
  args: MobileEnvironmentRecipeLifecycleArgs
): Promise<EnvironmentRecipeRuntime> {
  return destroyEnvironmentRecipe(mobileRequest(client), capabilities, args, isAmbiguous)
}

function mobileRequest(client: Pick<RpcClient, 'sendRequest'>): EnvironmentRecipeRequest {
  return async (method, params, options) => {
    const response = options
      ? await client.sendRequest(method, params, options)
      : await client.sendRequest(method, params)
    if (!response.ok) {
      throw Object.assign(new Error('Environment workspace RPC failed.'), {
        code: response.error.code
      })
    }
    return response.result
  }
}

function isAmbiguous(error: unknown): boolean {
  return isRpcDeliveryUnknown(error) || isLogicalClientCutoverError(error)
}
