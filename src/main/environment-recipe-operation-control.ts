import { createHash } from 'node:crypto'
import type { EnvironmentRecipeRuntime } from '../shared/environment-recipe-runtime-rpc'

const MAX_MUTATION_ENTRIES = 256
const MAX_ERROR_CHARS = 512

type MutationEntry = {
  fingerprint: string
  promise: Promise<EnvironmentRecipeRuntime>
  settled: boolean
}

const mutationEntries = new Map<string, MutationEntry>()
const runtimeOperationTails = new Map<string, Promise<void>>()

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
  pairedDeviceId: string,
  method: string,
  params: T,
  operation: () => Promise<EnvironmentRecipeRuntime>
): Promise<EnvironmentRecipeRuntime> {
  const key = `${pairedDeviceId}\0${method}\0${params.clientMutationId}`
  const fingerprint = JSON.stringify(params)
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
  evictSettledMutation()
  if (mutationEntries.size >= MAX_MUTATION_ENTRIES) {
    throw new EnvironmentRecipeRpcError(
      'environment_recipe_conflict',
      'Recipe operation capacity reached; retry after an in-flight operation finishes.'
    )
  }
  const entry: MutationEntry = {
    fingerprint,
    promise: Promise.resolve(null as never),
    settled: false
  }
  entry.promise = Promise.resolve()
    .then(operation)
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
      entry.settled = true
    }
  )
  return entry.promise
}

export async function runSerializedEnvironmentRecipeRuntimeOperation(
  runtimeId: string,
  operation: () => Promise<EnvironmentRecipeRuntime>
): Promise<EnvironmentRecipeRuntime> {
  const previous = runtimeOperationTails.get(runtimeId) ?? Promise.resolve()
  let release!: () => void
  const tail = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = previous.then(() => tail)
  runtimeOperationTails.set(runtimeId, queued)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (runtimeOperationTails.get(runtimeId) === queued) {
      runtimeOperationTails.delete(runtimeId)
    }
  }
}

export function environmentRecipeMutationRuntimeId(
  pairedDeviceId: string,
  clientMutationId: string
): string {
  const digest = createHash('sha256')
    .update(pairedDeviceId)
    .update('\0')
    .update(clientMutationId)
    .digest('hex')
    .slice(0, 32)
  return `remote-recipe-${digest}`
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
