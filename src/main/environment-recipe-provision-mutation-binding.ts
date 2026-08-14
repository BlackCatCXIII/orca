import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import {
  EnvironmentRecipeRpcError,
  type EnvironmentRecipeMutationControl
} from './environment-recipe-operation-control'

export function requireEnvironmentRecipeProvisionMutationBinding(
  runtime: EphemeralVmRuntimeRecord,
  mutation: Pick<EnvironmentRecipeMutationControl, 'requestSha256' | 'provisionRef'>
): void {
  if (
    runtime.provisionMutation &&
    (runtime.provisionMutation.requestSha256 !== mutation.requestSha256 ||
      (mutation.provisionRef && runtime.provisionMutation.resolvedRef !== mutation.provisionRef))
  ) {
    throw new EnvironmentRecipeRpcError(
      'environment_recipe_conflict',
      'This client mutation id was already used for a different recipe request.'
    )
  }
}

export function operatorEnvironmentRecipeProvisionMutationBinding(
  operatorRecipeCatalogSha256: string | undefined,
  mutation: EnvironmentRecipeMutationControl,
  resolvedRef: string | undefined
): {
  operatorRecipeCatalogSha256?: string
  provisionMutation?: EphemeralVmRuntimeRecord['provisionMutation']
  onTerminalProvisionFailure?: () => void
} {
  if (!operatorRecipeCatalogSha256) {
    return {}
  }
  return {
    operatorRecipeCatalogSha256,
    provisionMutation: { requestSha256: mutation.requestSha256, resolvedRef: resolvedRef! },
    onTerminalProvisionFailure: mutation.markProvisionTerminal
  }
}
