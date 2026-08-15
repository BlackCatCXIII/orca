import { listEphemeralVmRuntimes } from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import {
  readDurableEnvironmentRecipeMutation,
  type DurableEnvironmentRecipeMutation,
  type EnvironmentRecipeMutationIdentity
} from './environment-recipe-operation-journal'

export type EnvironmentRecipeProvisionReplay = {
  durable: DurableEnvironmentRecipeMutation | null
  provisionRef?: string
  runtimeId?: string
}

export class EnvironmentRecipeProvisionReplayConflict extends Error {
  constructor(readonly terminal = false) {
    super('Environment recipe provision replay binding conflicts with durable state.')
    this.name = 'EnvironmentRecipeProvisionReplayConflict'
  }
}

export function resolveEnvironmentRecipeProvisionReplay(
  userDataPath: string,
  identity: EnvironmentRecipeMutationIdentity,
  requestSha256: string,
  operatorRecipeCatalogSha256: string
): EnvironmentRecipeProvisionReplay {
  const durable = readDurableEnvironmentRecipeMutation(userDataPath, identity)
  if (durable) {
    requireMatchingDurableRequest(durable, requestSha256, operatorRecipeCatalogSha256)
    if (durable.state === 'terminal') {
      throw new EnvironmentRecipeProvisionReplayConflict(true)
    }
    if (durable.state === 'completed') {
      requireCompletedRuntimeBinding(userDataPath, durable)
    }
    return {
      durable,
      provisionRef: durable.provisionRef,
      runtimeId: durable.runtimeId
    }
  }
  return resolveRetainedRuntimeBinding(userDataPath, requestSha256, operatorRecipeCatalogSha256)
}

function requireMatchingDurableRequest(
  durable: DurableEnvironmentRecipeMutation,
  requestSha256: string,
  operatorRecipeCatalogSha256: string
): void {
  if (
    durable.fingerprint !== requestSha256 ||
    durable.operatorRecipeCatalogSha256 !== operatorRecipeCatalogSha256
  ) {
    throw new EnvironmentRecipeProvisionReplayConflict()
  }
}

function requireCompletedRuntimeBinding(
  userDataPath: string,
  durable: DurableEnvironmentRecipeMutation
): void {
  const runtime = listEphemeralVmRuntimes(userDataPath).find(
    (candidate) => candidate.id === durable.runtimeId
  )
  if (!runtimeBindingMatches(runtime, durable)) {
    throw new EnvironmentRecipeProvisionReplayConflict()
  }
}

function runtimeBindingMatches(
  runtime: EphemeralVmRuntimeRecord | undefined,
  binding: Pick<
    DurableEnvironmentRecipeMutation,
    'fingerprint' | 'provisionRef' | 'operatorRecipeCatalogSha256'
  >
): boolean {
  return Boolean(
    runtime?.provisionMutation?.requestSha256 === binding.fingerprint &&
    runtime.provisionMutation.resolvedRef === binding.provisionRef &&
    runtime.operatorRecipeCatalogSha256 === binding.operatorRecipeCatalogSha256
  )
}

function resolveRetainedRuntimeBinding(
  userDataPath: string,
  requestSha256: string,
  operatorRecipeCatalogSha256: string
): EnvironmentRecipeProvisionReplay {
  const matches = listEphemeralVmRuntimes(userDataPath).filter(
    (runtime) =>
      runtime.provisionMutation?.requestSha256 === requestSha256 &&
      runtime.operatorRecipeCatalogSha256 === operatorRecipeCatalogSha256
  )
  if (matches.length > 1) {
    throw new EnvironmentRecipeProvisionReplayConflict()
  }
  const runtime = matches[0]
  if (!runtime?.provisionMutation) {
    return { durable: null }
  }
  return {
    durable: null,
    provisionRef: runtime.provisionMutation.resolvedRef,
    runtimeId: runtime.id
  }
}
