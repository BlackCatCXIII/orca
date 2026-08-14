import { z } from 'zod'
import { toSshExecutionHostId } from './execution-host'
import type { OrcaVmRecipe } from './orca-yaml-hook-types'
import {
  getEphemeralVmRecipeResultCheckoutMode,
  getEphemeralVmRecipeResultConnection,
  getEphemeralVmRecipeResultProjectRoot
} from './ephemeral-vm-recipes'
import type { EphemeralVmRuntimeRecord } from './ephemeral-vm-runtimes'

export const ENVIRONMENT_RECIPE_RPC_METHODS = {
  list: 'environmentRecipes.list',
  provision: 'environmentRecipes.provision',
  suspend: 'environmentRecipes.suspend',
  resume: 'environmentRecipes.resume',
  destroy: 'environmentRecipes.destroy'
} as const

export const EnvironmentRecipeDescriptorSchema = z
  .object({
    repoId: z.string().min(1),
    recipeId: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    checkoutMode: z.enum(['orca-worktree', 'provisioned-root']),
    lifecycle: z
      .object({
        suspend: z.boolean(),
        resume: z.boolean(),
        destroy: z.boolean()
      })
      .strict()
  })
  .strict()

export type EnvironmentRecipeDescriptor = z.infer<typeof EnvironmentRecipeDescriptorSchema>

const EnvironmentRecipeRuntimeBaseSchema = z.object({
  runtimeId: z.string().min(1),
  repoId: z.string().min(1),
  recipeId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  workspaceName: z.string().min(1).optional(),
  checkoutMode: z.enum(['orca-worktree', 'provisioned-root']),
  status: z.enum([
    'provisioning',
    'running',
    'suspended',
    'suspend_failed',
    'resume_failed',
    'failed',
    'cleanup_pending',
    'cleanup_failed',
    'cleaned'
  ]),
  lifecycle: z
    .object({
      suspend: z.boolean(),
      resume: z.boolean(),
      destroy: z.boolean()
    })
    .strict(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite()
})

const ProvisionedRootSshAdoptionSchema = z
  .object({
    runtimeId: z.string().min(1),
    sourceRepoId: z.string().min(1),
    connectionId: z.string().min(1),
    executionHostId: z.string().startsWith('ssh:'),
    expectedPath: z.string().min(1)
  })
  .strict()

export const EnvironmentRecipeRuntimeSchema = z.discriminatedUnion('connectionType', [
  EnvironmentRecipeRuntimeBaseSchema.extend({
    connectionType: z.literal('orca-server'),
    projectRoot: z.string().min(1),
    environmentId: z.string().min(1).optional()
  }).strict(),
  EnvironmentRecipeRuntimeBaseSchema.extend({
    connectionType: z.literal('ssh'),
    projectRoot: z.string().min(1),
    sshTargetId: z.string().min(1).optional(),
    adoption: ProvisionedRootSshAdoptionSchema.optional()
  }).strict()
])

export type EnvironmentRecipeRuntime = z.infer<typeof EnvironmentRecipeRuntimeSchema>

export const EnvironmentRecipeListResultSchema = z
  .object({
    repoId: z.string().min(1),
    recipes: z.array(EnvironmentRecipeDescriptorSchema)
  })
  .strict()

export type EnvironmentRecipeListResult = z.infer<typeof EnvironmentRecipeListResultSchema>

export function toEnvironmentRecipeDescriptor(
  repoId: string,
  recipe: OrcaVmRecipe
): EnvironmentRecipeDescriptor {
  return {
    repoId,
    recipeId: recipe.id,
    name: recipe.name,
    ...(recipe.description ? { description: recipe.description } : {}),
    checkoutMode: recipe.checkoutMode ?? 'orca-worktree',
    lifecycle: {
      suspend: Boolean(recipe.suspend),
      resume: Boolean(recipe.resume),
      destroy: Boolean(recipe.destroy) && recipe.destroyDisabled !== true
    }
  }
}

export function toEnvironmentRecipeRuntime(
  runtime: EphemeralVmRuntimeRecord,
  recipe: OrcaVmRecipe = runtime.recipe ?? {
    id: runtime.recipeId,
    name: runtime.recipeId,
    create: ''
  }
): EnvironmentRecipeRuntime {
  if (!runtime.repoId) {
    throw new Error(`Ephemeral VM runtime has no repo id: ${runtime.id}`)
  }
  const connection = getEphemeralVmRecipeResultConnection(runtime.recipeResult)
  const checkoutMode = getEphemeralVmRecipeResultCheckoutMode(runtime.recipeResult)
  const base = {
    runtimeId: runtime.id,
    repoId: runtime.repoId,
    recipeId: runtime.recipeId,
    ...(runtime.workspaceId ? { workspaceId: runtime.workspaceId } : {}),
    ...(runtime.workspaceName ? { workspaceName: runtime.workspaceName } : {}),
    checkoutMode,
    status: runtime.status,
    lifecycle: toEnvironmentRecipeDescriptor(runtime.repoId, recipe).lifecycle,
    createdAt: runtime.createdAt,
    updatedAt: runtime.updatedAt,
    projectRoot: getEphemeralVmRecipeResultProjectRoot(runtime.recipeResult)
  }
  if (connection.type === 'orca-server') {
    return {
      ...base,
      connectionType: 'orca-server',
      ...(runtime.runtimeEnvironmentId ? { environmentId: runtime.runtimeEnvironmentId } : {})
    }
  }
  const sshTargetId = runtime.sshTargetId
  return {
    ...base,
    connectionType: 'ssh',
    ...(sshTargetId ? { sshTargetId } : {}),
    ...(checkoutMode === 'provisioned-root' && sshTargetId
      ? {
          adoption: {
            runtimeId: runtime.id,
            sourceRepoId: runtime.repoId,
            connectionId: sshTargetId,
            executionHostId: toSshExecutionHostId(sshTargetId),
            expectedPath: connection.projectRoot
          }
        }
      : {})
  }
}
