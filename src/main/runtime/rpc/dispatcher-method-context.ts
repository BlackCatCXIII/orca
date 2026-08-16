import type { OperatorEnvironmentRecipeCatalog } from '../../operator-environment-recipe-catalog'
import type { OrcaRuntimeService, OrchestrationCompatibilityCallerAuthority } from '../orca-runtime'
import type { RpcAnyMethod, RpcContext, RpcRequest } from './core'
import type { RpcDispatchStreamingOptions } from './dispatcher-stream-options'
import type { LegacyCoordinatorInvocation } from './orchestration-legacy-compatibility'
import type { DurableMutationInvocation } from './orchestration-mutation-executor'

export type DispatcherOptions = {
  runtime: OrcaRuntimeService
  methods?: readonly RpcAnyMethod[]
  userDataPath?: string
  operatorRecipeCatalog?: OperatorEnvironmentRecipeCatalog
}

export function dispatcherMethodContext(args: {
  runtime: OrcaRuntimeService
  operatorRecipeCatalog?: OperatorEnvironmentRecipeCatalog
  userDataPath?: string
  request: RpcRequest
  options?: RpcDispatchStreamingOptions
  mutation?: DurableMutationInvocation
  authenticatedCallerFingerprint?: string
  legacyCoordinator?: LegacyCoordinatorInvocation
  compatibilityCallerAuthority?: OrchestrationCompatibilityCallerAuthority
}): RpcContext {
  const { options, request } = args
  return {
    runtime: args.runtime,
    operatorRecipeCatalog: args.operatorRecipeCatalog,
    userDataPath: args.userDataPath,
    signal: options?.signal,
    requestId: request.id,
    connectionId: options?.connectionId,
    clientId: options?.clientId,
    pairedDeviceId: options?.pairedDeviceId,
    clientKind: options?.clientKind,
    clientCapabilities: options?.clientCapabilities,
    orchestrationCapability: request.orchestrationCapability,
    authenticatedCallerFingerprint:
      args.mutation?.identity.callerFingerprint ?? args.authenticatedCallerFingerprint,
    recordMutationReceipt: args.mutation?.recordReceipt,
    orchestrationMutation: args.mutation?.identity,
    pairing: options?.pairing,
    sendBinary: options?.sendBinary,
    registerBinaryStreamHandler: options?.registerBinaryStreamHandler,
    legacyCoordinatorRunId: args.legacyCoordinator?.revalidate(),
    legacyCoordinatorAuthority: args.legacyCoordinator?.authority,
    revalidateLegacyCoordinator: args.legacyCoordinator?.revalidate,
    orchestrationCompatibilityCallerAuthority: args.compatibilityCallerAuthority,
    orchestrationCompatibilityEvidence: request.orchestrationCompatibilityEvidence
  }
}
