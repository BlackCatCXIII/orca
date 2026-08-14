import { z } from 'zod'
import { ENVIRONMENT_RECIPE_RPC_METHODS } from '../../../../shared/environment-recipe-runtime-rpc'
import {
  destroyEnvironmentRecipeForRpc,
  listEnvironmentRecipeRuntimesForRpc,
  listEnvironmentRecipesForRpc,
  provisionEnvironmentRecipeForRpc,
  resumeEnvironmentRecipeForRpc,
  suspendEnvironmentRecipeForRpc,
  type EnvironmentRecipeRuntimeRpcDependencies
} from '../../../environment-recipe-runtime-rpc-service'
import { defineMethod, type RpcContext, type RpcMethod } from '../core'
import { getApprovedPluginVmRecipesForRpc } from './plugins'

const ScopedRecipe = z
  .object({
    repoId: z.string().trim().min(1, 'Missing repo ID').max(512),
    recipeId: z.string().trim().min(1, 'Missing recipe ID').max(512)
  })
  .strict()

const ListRecipes = z
  .object({
    repoId: z.string().trim().min(1, 'Missing repo ID').max(512)
  })
  .strict()

const ClientMutationId = z.string().trim().min(1, 'Missing client mutation ID').max(128)

const ProvisionRecipe = ScopedRecipe.extend({
  clientMutationId: ClientMutationId,
  projectId: z.string().trim().min(1).max(512).optional(),
  workspaceId: z.string().trim().min(1).max(2048).optional(),
  workspaceName: z.string().trim().min(1).max(512).optional(),
  branch: z.string().trim().min(1).max(1024).optional(),
  ref: z.string().trim().min(1).max(1024).optional()
}).strict()

const LifecycleRecipe = ScopedRecipe.extend({
  runtimeId: z.string().trim().min(1, 'Missing runtime ID').max(512),
  clientMutationId: ClientMutationId
}).strict()

function dependencies(context: RpcContext): EnvironmentRecipeRuntimeRpcDependencies {
  if (!context.pairedDeviceId) {
    throw Object.assign(
      new Error('Environment recipe lifecycle requires an authenticated paired device.'),
      { code: 'environment_recipe_forbidden' }
    )
  }
  if (!context.userDataPath) {
    throw new Error('Environment recipe lifecycle storage is unavailable.')
  }
  return {
    runtime: context.runtime,
    userDataPath: context.userDataPath,
    pairedDeviceId: context.pairedDeviceId,
    getPluginRecipes: getApprovedPluginVmRecipesForRpc,
    operatorRecipeCatalog: context.operatorRecipeCatalog
  }
}

export const ENVIRONMENT_RECIPE_METHODS: readonly RpcMethod[] = [
  defineMethod({
    name: ENVIRONMENT_RECIPE_RPC_METHODS.list,
    params: ListRecipes,
    handler: (params, context) => listEnvironmentRecipesForRpc(dependencies(context), params.repoId)
  }),
  defineMethod({
    name: ENVIRONMENT_RECIPE_RPC_METHODS.listRuntimes,
    params: ListRecipes,
    handler: (params, context) =>
      listEnvironmentRecipeRuntimesForRpc(dependencies(context), params.repoId)
  }),
  defineMethod({
    name: ENVIRONMENT_RECIPE_RPC_METHODS.provision,
    params: ProvisionRecipe,
    // Why: after admission, host lifecycle owns completion; transport aborts may have ambiguous delivery and retries reconcile through clientMutationId.
    handler: (params, context) => provisionEnvironmentRecipeForRpc(dependencies(context), params)
  }),
  defineMethod({
    name: ENVIRONMENT_RECIPE_RPC_METHODS.suspend,
    params: LifecycleRecipe,
    handler: (params, context) => suspendEnvironmentRecipeForRpc(dependencies(context), params)
  }),
  defineMethod({
    name: ENVIRONMENT_RECIPE_RPC_METHODS.resume,
    params: LifecycleRecipe,
    handler: (params, context) => resumeEnvironmentRecipeForRpc(dependencies(context), params)
  }),
  defineMethod({
    name: ENVIRONMENT_RECIPE_RPC_METHODS.destroy,
    params: LifecycleRecipe,
    handler: (params, context) => destroyEnvironmentRecipeForRpc(dependencies(context), params)
  })
]
