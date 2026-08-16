import type { z } from 'zod'
import {
  ENVIRONMENT_RECIPE_RPC_METHODS,
  EnvironmentRecipeListResultSchema,
  EnvironmentRecipeRuntimeListResultSchema,
  EnvironmentRecipeRuntimeSchema,
  type EnvironmentRecipeListResult,
  type EnvironmentRecipeRuntime,
  type EnvironmentRecipeRuntimeListResult
} from './environment-recipe-runtime-rpc'
import {
  ENVIRONMENT_RECIPE_LIFECYCLE_RUNTIME_CAPABILITY,
  ENVIRONMENT_RECIPE_MANAGEMENT_RUNTIME_CAPABILITY
} from './protocol-version'

const RECIPE_RPC_TIMEOUT_MS = 10 * 60_000
const MAX_AMBIGUOUS_RETRIES = 3

export type EnvironmentRecipeProvisionArgs = {
  repoId: string
  recipeId: string
  clientMutationId: string
  projectId?: string
  workspaceId?: string
  workspaceName?: string
  branch?: string
  ref?: string
}

export type EnvironmentRecipeLifecycleArgs = {
  repoId: string
  recipeId: string
  runtimeId: string
  clientMutationId: string
}

export type EnvironmentRecipeRequest = (
  method: string,
  params: unknown,
  options?: { timeoutMs?: number }
) => Promise<unknown>

export class EnvironmentRecipeClientError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'EnvironmentRecipeClientError'
    this.code = code
  }
}

export function supportsEnvironmentRecipeLifecycle(capabilities: readonly string[]): boolean {
  return capabilities.includes(ENVIRONMENT_RECIPE_LIFECYCLE_RUNTIME_CAPABILITY)
}

export function supportsEnvironmentRecipeManagement(capabilities: readonly string[]): boolean {
  return (
    supportsEnvironmentRecipeLifecycle(capabilities) &&
    capabilities.includes(ENVIRONMENT_RECIPE_MANAGEMENT_RUNTIME_CAPABILITY)
  )
}

export function listEnvironmentRecipes(
  request: EnvironmentRecipeRequest,
  capabilities: readonly string[],
  repoId: string
): Promise<EnvironmentRecipeListResult> {
  return readResult(
    request,
    capabilities,
    ENVIRONMENT_RECIPE_RPC_METHODS.list,
    { repoId },
    EnvironmentRecipeListResultSchema
  )
}

export function listEnvironmentRecipeRuntimes(
  request: EnvironmentRecipeRequest,
  capabilities: readonly string[],
  repoId: string
): Promise<EnvironmentRecipeRuntimeListResult> {
  return readResult(
    request,
    capabilities,
    ENVIRONMENT_RECIPE_RPC_METHODS.listRuntimes,
    { repoId },
    EnvironmentRecipeRuntimeListResultSchema,
    true
  )
}

export function provisionEnvironmentRecipe(
  request: EnvironmentRecipeRequest,
  capabilities: readonly string[],
  args: EnvironmentRecipeProvisionArgs,
  isAmbiguousError: (error: unknown) => boolean
): Promise<EnvironmentRecipeRuntime> {
  return sendMutation(
    request,
    capabilities,
    ENVIRONMENT_RECIPE_RPC_METHODS.provision,
    args,
    isAmbiguousError
  )
}

export function suspendEnvironmentRecipe(
  request: EnvironmentRecipeRequest,
  capabilities: readonly string[],
  args: EnvironmentRecipeLifecycleArgs,
  isAmbiguousError: (error: unknown) => boolean
): Promise<EnvironmentRecipeRuntime> {
  return sendMutation(
    request,
    capabilities,
    ENVIRONMENT_RECIPE_RPC_METHODS.suspend,
    args,
    isAmbiguousError
  )
}

export function resumeEnvironmentRecipe(
  request: EnvironmentRecipeRequest,
  capabilities: readonly string[],
  args: EnvironmentRecipeLifecycleArgs,
  isAmbiguousError: (error: unknown) => boolean
): Promise<EnvironmentRecipeRuntime> {
  return sendMutation(
    request,
    capabilities,
    ENVIRONMENT_RECIPE_RPC_METHODS.resume,
    args,
    isAmbiguousError
  )
}

export function destroyEnvironmentRecipe(
  request: EnvironmentRecipeRequest,
  capabilities: readonly string[],
  args: EnvironmentRecipeLifecycleArgs,
  isAmbiguousError: (error: unknown) => boolean
): Promise<EnvironmentRecipeRuntime> {
  return sendMutation(
    request,
    capabilities,
    ENVIRONMENT_RECIPE_RPC_METHODS.destroy,
    args,
    isAmbiguousError
  )
}

async function readResult<T>(
  request: EnvironmentRecipeRequest,
  capabilities: readonly string[],
  method: string,
  params: unknown,
  schema: z.ZodType<T>,
  management = false
): Promise<T> {
  if (management) {
    requireManagementCapability(capabilities)
  } else {
    requireCapability(capabilities)
  }
  try {
    return schema.parse(await request(method, params))
  } catch (error) {
    throw safeClientError(error, 'Could not load environment recipes from this host.')
  }
}

async function sendMutation(
  request: EnvironmentRecipeRequest,
  capabilities: readonly string[],
  method: string,
  params: EnvironmentRecipeProvisionArgs | EnvironmentRecipeLifecycleArgs,
  isAmbiguousError: (error: unknown) => boolean
): Promise<EnvironmentRecipeRuntime> {
  requireCapability(capabilities)
  for (let retry = 0; ; retry += 1) {
    try {
      const result = await request(method, params, { timeoutMs: RECIPE_RPC_TIMEOUT_MS })
      return EnvironmentRecipeRuntimeSchema.parse(result)
    } catch (error) {
      if (retry < MAX_AMBIGUOUS_RETRIES && isAmbiguousError(error)) {
        continue
      }
      throw safeClientError(error, 'Environment workspace operation failed on the runtime host.')
    }
  }
}

function requireCapability(capabilities: readonly string[]): void {
  if (!supportsEnvironmentRecipeLifecycle(capabilities)) {
    throw new EnvironmentRecipeClientError(
      'unsupported_capability',
      'Update Orca on this host to manage environment workspaces remotely.'
    )
  }
}

function requireManagementCapability(capabilities: readonly string[]): void {
  if (!supportsEnvironmentRecipeManagement(capabilities)) {
    throw new EnvironmentRecipeClientError(
      'unsupported_capability',
      'Update Orca on this host to manage environment workspaces remotely.'
    )
  }
}

function safeClientError(error: unknown, fallback: string): EnvironmentRecipeClientError {
  if (error instanceof EnvironmentRecipeClientError) {
    return error
  }
  const code = readErrorCode(error)
  if (code === 'environment_recipe_forbidden') {
    return new EnvironmentRecipeClientError(
      code,
      'This paired device cannot manage environment workspaces.'
    )
  }
  if (code === 'environment_recipe_not_found') {
    return new EnvironmentRecipeClientError(
      code,
      'The environment recipe or workspace is no longer available.'
    )
  }
  if (code === 'environment_recipe_conflict') {
    return new EnvironmentRecipeClientError(
      code,
      'The environment workspace changed while this action was pending. Refresh and try again.'
    )
  }
  return new EnvironmentRecipeClientError(code ?? 'environment_recipe_failed', fallback)
}

function readErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null
  }
  const candidate = error as { code?: unknown; response?: { error?: { code?: unknown } } }
  if (typeof candidate.code === 'string') {
    return candidate.code
  }
  return typeof candidate.response?.error?.code === 'string' ? candidate.response.error.code : null
}
