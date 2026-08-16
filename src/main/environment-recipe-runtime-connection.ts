import type { OrcaVmRecipe } from '../shared/orca-yaml-hook-types'
import type { Repo } from '../shared/repo-types'
import {
  getEphemeralVmRecipeResultConnection,
  getEphemeralVmRecipeResultPairingCode
} from '../shared/ephemeral-vm-recipes'
import { updateEphemeralVmRuntimeStatus } from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import {
  addEnvironmentFromPairingCode,
  removeEnvironment,
  updateEnvironmentFromPairingCode
} from '../shared/runtime-environment-store'
import { toEnvironmentRecipeRuntime } from '../shared/environment-recipe-runtime-rpc'
import type { EnvironmentRecipeRuntime } from '../shared/environment-recipe-runtime-rpc'
import { cleanupEphemeralVmRuntime } from './ephemeral-vm-runtime-service'
import { EnvironmentRecipeRpcError } from './environment-recipe-operation-control'
import type { OperatorEnvironmentRecipeCatalog } from './operator-environment-recipe-catalog'

type EnvironmentRecipeConnectionContext = {
  userDataPath: string
  operatorRecipeCatalog?: OperatorEnvironmentRecipeCatalog
}

export async function finalizeProvisionedEnvironmentRecipeRuntime(
  context: EnvironmentRecipeConnectionContext,
  repo: Repo,
  recipe: OrcaVmRecipe,
  runtime: EphemeralVmRuntimeRecord
): Promise<EnvironmentRecipeRuntime> {
  let createdSshTargetId: string | undefined
  let createdEnvironmentId: string | undefined
  try {
    const connection = getEphemeralVmRecipeResultConnection(runtime.recipeResult)
    if (connection.type === 'ssh') {
      if (runtime.sshTargetId) {
        return toEnvironmentRecipeRuntime(runtime, recipe)
      }
      const { connectRuntimeOwnedSshTarget } = await import('./ephemeral-vm-runtime-ssh')
      const ssh = await connectRuntimeOwnedSshTarget({ runtimeId: runtime.id, connection })
      createdSshTargetId = ssh.targetId
      return toEnvironmentRecipeRuntime(
        updateEphemeralVmRuntimeStatus(context.userDataPath, runtime.id, {
          connectionMode: 'ssh',
          sshTargetId: ssh.targetId
        }),
        recipe
      )
    }
    if (runtime.runtimeEnvironmentId) {
      return toEnvironmentRecipeRuntime(runtime, recipe)
    }
    const environment = addEnvironmentFromPairingCode(context.userDataPath, {
      name: `${repo.displayName} VM ${runtime.id.slice(-8)}`,
      pairingCode: connection.pairingCode,
      source: 'ephemeral-vm'
    })
    createdEnvironmentId = environment.id
    return toEnvironmentRecipeRuntime(
      updateEphemeralVmRuntimeStatus(context.userDataPath, runtime.id, {
        connectionMode: 'orca-server',
        runtimeEnvironmentId: environment.id
      }),
      recipe
    )
  } catch (error) {
    if (createdSshTargetId) {
      const { removeRuntimeOwnedSshTarget } = await import('./ephemeral-vm-runtime-ssh')
      await removeRuntimeOwnedSshTarget(createdSshTargetId).catch(() => undefined)
    }
    if (createdEnvironmentId) {
      try {
        removeEnvironment(context.userDataPath, createdEnvironmentId)
      } catch {
        // The original setup error remains authoritative.
      }
    }
    await cleanupEphemeralVmRuntime({
      userDataPath: context.userDataPath,
      repoPath: repo.path,
      recipe,
      runtimeId: runtime.id,
      executionMode: context.operatorRecipeCatalog ? 'direct' : 'shell',
      operatorRecipeCatalogSha256: context.operatorRecipeCatalog?.status.digest
    }).catch(() => undefined)
    throw failedConnectionSetup('Provision setup', error)
  }
}

export async function finalizeResumedEnvironmentRecipeRuntime(
  context: EnvironmentRecipeConnectionContext,
  recipe: OrcaVmRecipe,
  runtime: EphemeralVmRuntimeRecord
): Promise<EnvironmentRecipeRuntime> {
  const connection = getEphemeralVmRecipeResultConnection(runtime.recipeResult)
  let createdSshTargetId: string | undefined
  try {
    if (connection.type === 'ssh') {
      const { connectRuntimeOwnedSshTarget } = await import('./ephemeral-vm-runtime-ssh')
      const ssh = await connectRuntimeOwnedSshTarget({ runtimeId: runtime.id, connection })
      createdSshTargetId = ssh.targetId
      return toEnvironmentRecipeRuntime(
        updateEphemeralVmRuntimeStatus(context.userDataPath, runtime.id, {
          connectionMode: 'ssh',
          sshTargetId: ssh.targetId
        }),
        recipe
      )
    }
    if (!runtime.runtimeEnvironmentId) {
      throw new Error('The recipe-created runtime environment is missing.')
    }
    const pairingCode = getEphemeralVmRecipeResultPairingCode(runtime.recipeResult)
    if (!pairingCode) {
      throw new Error('The resumed recipe did not return an Orca Server pairing code.')
    }
    updateEnvironmentFromPairingCode(context.userDataPath, runtime.runtimeEnvironmentId, {
      pairingCode
    })
    const { invalidateRuntimeEnvironmentTransport } = await import('./ipc/runtime-environments')
    invalidateRuntimeEnvironmentTransport(runtime.runtimeEnvironmentId)
    return toEnvironmentRecipeRuntime(runtime, recipe)
  } catch (error) {
    if (createdSshTargetId) {
      const { removeRuntimeOwnedSshTarget } = await import('./ephemeral-vm-runtime-ssh')
      await removeRuntimeOwnedSshTarget(createdSshTargetId).catch(() => undefined)
    }
    updateEphemeralVmRuntimeStatus(context.userDataPath, runtime.id, { status: 'resume_failed' })
    throw failedConnectionSetup('Resume setup', error)
  }
}

function failedConnectionSetup(action: string, _error: unknown): EnvironmentRecipeRpcError {
  return new EnvironmentRecipeRpcError(
    'environment_recipe_failed',
    `${action} failed on the runtime host.`
  )
}
