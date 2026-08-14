import {
  ENVIRONMENT_RECIPE_RPC_METHODS,
  EnvironmentRecipeListResultSchema,
  EnvironmentRecipeRuntimeSchema,
  type EnvironmentRecipeListResult,
  type EnvironmentRecipeRuntime
} from '../../../src/shared/environment-recipe-runtime-rpc'
import { ENVIRONMENT_RECIPE_LIFECYCLE_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { RpcClient } from '../transport/rpc-client'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'

const RECIPE_RPC_TIMEOUT_MS = 10 * 60_000
const MAX_AMBIGUOUS_RETRIES = 3

type RecipeScope = {
  repoId: string
  recipeId: string
}

export type MobileEnvironmentRecipeProvisionArgs = RecipeScope & {
  clientMutationId: string
  projectId?: string
  workspaceId?: string
  workspaceName?: string
  branch?: string
  ref?: string
}

export type MobileEnvironmentRecipeLifecycleArgs = RecipeScope & {
  runtimeId: string
  clientMutationId: string
}

export function supportsEnvironmentRecipeLifecycle(capabilities: readonly string[]): boolean {
  return capabilities.includes(ENVIRONMENT_RECIPE_LIFECYCLE_RUNTIME_CAPABILITY)
}

export async function listMobileEnvironmentRecipes(
  client: Pick<RpcClient, 'sendRequest'>,
  capabilities: readonly string[],
  repoId: string
): Promise<EnvironmentRecipeListResult> {
  requireCapability(capabilities)
  const response = await client.sendRequest(ENVIRONMENT_RECIPE_RPC_METHODS.list, { repoId })
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return EnvironmentRecipeListResultSchema.parse(response.result)
}

export function provisionMobileEnvironmentRecipe(
  client: Pick<RpcClient, 'sendRequest'>,
  capabilities: readonly string[],
  args: MobileEnvironmentRecipeProvisionArgs
): Promise<EnvironmentRecipeRuntime> {
  return sendMutation(client, capabilities, ENVIRONMENT_RECIPE_RPC_METHODS.provision, args)
}

export function suspendMobileEnvironmentRecipe(
  client: Pick<RpcClient, 'sendRequest'>,
  capabilities: readonly string[],
  args: MobileEnvironmentRecipeLifecycleArgs
): Promise<EnvironmentRecipeRuntime> {
  return sendMutation(client, capabilities, ENVIRONMENT_RECIPE_RPC_METHODS.suspend, args)
}

export function resumeMobileEnvironmentRecipe(
  client: Pick<RpcClient, 'sendRequest'>,
  capabilities: readonly string[],
  args: MobileEnvironmentRecipeLifecycleArgs
): Promise<EnvironmentRecipeRuntime> {
  return sendMutation(client, capabilities, ENVIRONMENT_RECIPE_RPC_METHODS.resume, args)
}

export function destroyMobileEnvironmentRecipe(
  client: Pick<RpcClient, 'sendRequest'>,
  capabilities: readonly string[],
  args: MobileEnvironmentRecipeLifecycleArgs
): Promise<EnvironmentRecipeRuntime> {
  return sendMutation(client, capabilities, ENVIRONMENT_RECIPE_RPC_METHODS.destroy, args)
}

async function sendMutation(
  client: Pick<RpcClient, 'sendRequest'>,
  capabilities: readonly string[],
  method: string,
  params: MobileEnvironmentRecipeProvisionArgs | MobileEnvironmentRecipeLifecycleArgs
): Promise<EnvironmentRecipeRuntime> {
  requireCapability(capabilities)
  for (let retry = 0; ; retry += 1) {
    try {
      const response = await client.sendRequest(method, params, {
        timeoutMs: RECIPE_RPC_TIMEOUT_MS
      })
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      return EnvironmentRecipeRuntimeSchema.parse(response.result)
    } catch (error) {
      if (
        retry >= MAX_AMBIGUOUS_RETRIES ||
        (!isRpcDeliveryUnknown(error) && !isLogicalClientCutoverError(error))
      ) {
        throw error
      }
    }
  }
}

function requireCapability(capabilities: readonly string[]): void {
  if (!supportsEnvironmentRecipeLifecycle(capabilities)) {
    throw new Error('Update Orca on this host to manage environment recipes remotely.')
  }
}
