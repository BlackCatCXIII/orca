import {
  destroyEnvironmentRecipe,
  listEnvironmentRecipeRuntimes,
  listEnvironmentRecipes,
  provisionEnvironmentRecipe,
  resumeEnvironmentRecipe,
  suspendEnvironmentRecipe,
  type EnvironmentRecipeLifecycleArgs,
  type EnvironmentRecipeProvisionArgs,
  type EnvironmentRecipeRequest
} from '../../../shared/environment-recipe-client'
import type {
  EnvironmentRecipeListResult,
  EnvironmentRecipeRuntime,
  EnvironmentRecipeRuntimeListResult
} from '../../../shared/environment-recipe-runtime-rpc'
import { ENVIRONMENT_RECIPE_LIFECYCLE_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from '../../../shared/remote-runtime-client-error-classification'
import { callRuntimeRpc, getRuntimeEnvironmentStatus } from '@/runtime/runtime-rpc-client'

async function capabilities(environmentId: string): Promise<readonly string[]> {
  const status = await getRuntimeEnvironmentStatus(environmentId, 15_000)
  return status.capabilities ?? []
}

function request(environmentId: string): EnvironmentRecipeRequest {
  return (method, params, options) =>
    callRuntimeRpc({ kind: 'environment', environmentId }, method, params, {
      timeoutMs: options?.timeoutMs
    })
}

function isAmbiguous(error: unknown): boolean {
  return isRecoverableRemoteRuntimeConnectionError(toRemoteRuntimeClientErrorLike(error))
}

export async function desktopSupportsEnvironmentRecipeLifecycle(
  environmentId: string
): Promise<boolean> {
  return (await capabilities(environmentId)).includes(
    ENVIRONMENT_RECIPE_LIFECYCLE_RUNTIME_CAPABILITY
  )
}

export async function listDesktopEnvironmentRecipes(
  environmentId: string,
  repoId: string
): Promise<EnvironmentRecipeListResult> {
  return listEnvironmentRecipes(request(environmentId), await capabilities(environmentId), repoId)
}

export async function listDesktopEnvironmentRecipeRuntimes(
  environmentId: string,
  repoId: string
): Promise<EnvironmentRecipeRuntimeListResult> {
  return listEnvironmentRecipeRuntimes(
    request(environmentId),
    await capabilities(environmentId),
    repoId
  )
}

export async function provisionDesktopEnvironmentRecipe(
  environmentId: string,
  args: EnvironmentRecipeProvisionArgs
): Promise<EnvironmentRecipeRuntime> {
  return provisionEnvironmentRecipe(
    request(environmentId),
    await capabilities(environmentId),
    args,
    isAmbiguous
  )
}

export async function suspendDesktopEnvironmentRecipe(
  environmentId: string,
  args: EnvironmentRecipeLifecycleArgs
): Promise<EnvironmentRecipeRuntime> {
  return suspendEnvironmentRecipe(
    request(environmentId),
    await capabilities(environmentId),
    args,
    isAmbiguous
  )
}

export async function resumeDesktopEnvironmentRecipe(
  environmentId: string,
  args: EnvironmentRecipeLifecycleArgs
): Promise<EnvironmentRecipeRuntime> {
  return resumeEnvironmentRecipe(
    request(environmentId),
    await capabilities(environmentId),
    args,
    isAmbiguous
  )
}

export async function destroyDesktopEnvironmentRecipe(
  environmentId: string,
  args: EnvironmentRecipeLifecycleArgs
): Promise<EnvironmentRecipeRuntime> {
  return destroyEnvironmentRecipe(
    request(environmentId),
    await capabilities(environmentId),
    args,
    isAmbiguous
  )
}
