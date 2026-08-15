import type { EnvironmentRecipeRuntime } from '../shared/environment-recipe-runtime-rpc'
import {
  classifyDurableEnvironmentRecipeMutationFromStore,
  EnvironmentRecipeOperationJournalError,
  prepareDurableEnvironmentRecipeMutation,
  type DurableEnvironmentRecipeMutation,
  type EnvironmentRecipeMutationIdentity
} from './environment-recipe-operation-journal'
import {
  canonicalEnvironmentRecipeMutationJson,
  environmentRecipeMutationRequestSha256,
  normalizeEnvironmentRecipeProfilePath
} from './environment-recipe-mutation-identity'
import {
  EnvironmentRecipeProvisionReplayConflict,
  resolveEnvironmentRecipeProvisionReplay
} from './environment-recipe-provision-replay'

const MAX_MUTATION_ENTRIES = 256
const MAX_ERROR_CHARS = 512

export {
  environmentRecipeMutationRequestSha256,
  environmentRecipeMutationRuntimeId
} from './environment-recipe-mutation-identity'

type MutationEntry = {
  fingerprint: string
  promise: Promise<EnvironmentRecipeRuntime>
  settled: boolean
}

const mutationEntries = new Map<string, MutationEntry>()
const runtimeOperationTails = new Map<string, Promise<void>>()

export type EnvironmentRecipeMutationControl = {
  readonly requestSha256: string
  readonly provisionRef?: string
  readonly runtimeId?: string
  persistProvisionRef: (ref: string, runtimeId: string) => void
  markProvisionTerminal: () => void
}

export class EnvironmentRecipeRpcError extends Error {
  readonly code:
    | 'environment_recipe_forbidden'
    | 'environment_recipe_not_found'
    | 'environment_recipe_conflict'
    | 'environment_recipe_failed'

  constructor(code: EnvironmentRecipeRpcError['code'], message: string) {
    super(message.slice(0, MAX_ERROR_CHARS))
    this.name = 'EnvironmentRecipeRpcError'
    this.code = code
  }
}

export function runIdempotentEnvironmentRecipeMutation<T extends { clientMutationId: string }>(
  profilePath: string,
  pairedDeviceId: string,
  method: string,
  params: T,
  operation: (control: EnvironmentRecipeMutationControl) => Promise<EnvironmentRecipeRuntime>,
  options: { operatorRecipeCatalogSha256?: string } = {}
): Promise<EnvironmentRecipeRuntime> {
  const key = `${normalizeEnvironmentRecipeProfilePath(profilePath)}\0${pairedDeviceId}\0${method}\0${params.clientMutationId}`
  const fingerprint = canonicalEnvironmentRecipeMutationJson(params)
  const requestSha256 = environmentRecipeMutationRequestSha256(params)
  const existing = mutationEntries.get(key)
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new EnvironmentRecipeRpcError(
        'environment_recipe_conflict',
        'This client mutation id was already used for a different recipe request.'
      )
    }
    return existing.promise
  }
  const identity = { pairedDeviceId, method, clientMutationId: params.clientMutationId }
  const replay = options.operatorRecipeCatalogSha256
    ? readProvisionReplayOrThrow(
        profilePath,
        identity,
        requestSha256,
        options.operatorRecipeCatalogSha256
      )
    : null
  let durable = replay?.durable ?? null
  evictSettledMutation()
  if (mutationEntries.size >= MAX_MUTATION_ENTRIES) {
    throw new EnvironmentRecipeRpcError(
      'environment_recipe_conflict',
      'Recipe operation capacity reached; retry after an in-flight operation finishes.'
    )
  }
  const control: EnvironmentRecipeMutationControl = {
    requestSha256,
    provisionRef: replay?.provisionRef,
    runtimeId: replay?.runtimeId,
    persistProvisionRef: (ref, runtimeId) => {
      if (!options.operatorRecipeCatalogSha256) {
        return
      }
      durable = prepareDurableMutationOrThrow(
        profilePath,
        identity,
        requestSha256,
        ref,
        runtimeId,
        options.operatorRecipeCatalogSha256
      )
    },
    markProvisionTerminal: () => {
      if (!durable) {
        return
      }
      try {
        if (
          classifyDurableEnvironmentRecipeMutationFromStore(profilePath, durable) !== 'terminal'
        ) {
          throw new EnvironmentRecipeOperationJournalError('invalid')
        }
        durable = { ...durable, state: 'terminal', updatedAt: Date.now() }
      } catch (error) {
        throw journalFailure(error)
      }
    }
  }
  const entry: MutationEntry = {
    fingerprint,
    promise: Promise.resolve(null as never),
    settled: false
  }
  entry.promise = Promise.resolve()
    .then(() => operation(control))
    .then((result) => {
      if (durable) {
        try {
          if (
            classifyDurableEnvironmentRecipeMutationFromStore(profilePath, durable) !== 'completed'
          ) {
            throw new EnvironmentRecipeOperationJournalError('invalid')
          }
        } catch (error) {
          throw journalFailure(error)
        }
      }
      return result
    })
    .catch((error: unknown) => {
      if (error instanceof EnvironmentRecipeRpcError) {
        throw error
      }
      throw new EnvironmentRecipeRpcError(
        'environment_recipe_failed',
        'Recipe operation failed on the runtime host.'
      )
    })
  mutationEntries.set(key, entry)
  void entry.promise.then(
    () => {
      entry.settled = true
    },
    () => {
      if (durable?.state === 'terminal' && mutationEntries.get(key) === entry) {
        mutationEntries.delete(key)
      } else {
        entry.settled = true
      }
    }
  )
  return entry.promise
}

function readProvisionReplayOrThrow(
  profilePath: string,
  identity: EnvironmentRecipeMutationIdentity,
  fingerprint: string,
  operatorRecipeCatalogSha256: string
): ReturnType<typeof resolveEnvironmentRecipeProvisionReplay> {
  try {
    return resolveEnvironmentRecipeProvisionReplay(
      profilePath,
      identity,
      fingerprint,
      operatorRecipeCatalogSha256
    )
  } catch (error) {
    if (error instanceof EnvironmentRecipeProvisionReplayConflict) {
      throw error.terminal ? terminalMutationConflict() : mutationConflict()
    }
    throw journalFailure(error)
  }
}

function prepareDurableMutationOrThrow(
  profilePath: string,
  identity: EnvironmentRecipeMutationIdentity,
  fingerprint: string,
  provisionRef: string,
  runtimeId: string,
  operatorRecipeCatalogSha256: string
): DurableEnvironmentRecipeMutation {
  let durable: DurableEnvironmentRecipeMutation
  try {
    durable = prepareDurableEnvironmentRecipeMutation(profilePath, {
      ...identity,
      fingerprint,
      provisionRef,
      runtimeId,
      operatorRecipeCatalogSha256
    })
  } catch (error) {
    throw journalFailure(error)
  }
  if (
    durable.fingerprint !== fingerprint ||
    durable.provisionRef !== provisionRef ||
    durable.runtimeId !== runtimeId ||
    durable.operatorRecipeCatalogSha256 !== operatorRecipeCatalogSha256
  ) {
    throw mutationConflict()
  }
  return durable
}

function mutationConflict(): EnvironmentRecipeRpcError {
  return new EnvironmentRecipeRpcError(
    'environment_recipe_conflict',
    'This client mutation id was already used for a different recipe request.'
  )
}

function terminalMutationConflict(): EnvironmentRecipeRpcError {
  return new EnvironmentRecipeRpcError(
    'environment_recipe_conflict',
    'This provision attempt already ended. Start a new attempt.'
  )
}

function journalFailure(error: unknown): EnvironmentRecipeRpcError {
  if (error instanceof EnvironmentRecipeOperationJournalError && error.code === 'capacity') {
    return new EnvironmentRecipeRpcError(
      'environment_recipe_conflict',
      'Recipe operation capacity reached; retry after an in-flight operation finishes.'
    )
  }
  return new EnvironmentRecipeRpcError(
    'environment_recipe_failed',
    'Recipe operation could not be recorded safely on the runtime host.'
  )
}

export async function runSerializedEnvironmentRecipeRuntimeOperation(
  profilePath: string,
  runtimeId: string,
  operation: () => Promise<EnvironmentRecipeRuntime>
): Promise<EnvironmentRecipeRuntime> {
  const key = `${normalizeEnvironmentRecipeProfilePath(profilePath)}\0${runtimeId}`
  const previous = runtimeOperationTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const tail = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = previous.then(() => tail)
  runtimeOperationTails.set(key, queued)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (runtimeOperationTails.get(key) === queued) {
      runtimeOperationTails.delete(key)
    }
  }
}

export function resetEnvironmentRecipeOperationControlForTests(): void {
  mutationEntries.clear()
  runtimeOperationTails.clear()
}

function evictSettledMutation(): void {
  if (mutationEntries.size < MAX_MUTATION_ENTRIES) {
    return
  }
  for (const [key, entry] of mutationEntries) {
    if (entry.settled) {
      mutationEntries.delete(key)
      return
    }
  }
}
