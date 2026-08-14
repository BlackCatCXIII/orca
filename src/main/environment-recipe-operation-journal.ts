import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { readNodeFileSyncWithinLimit } from '../shared/node-bounded-file-reader'
import { stringifyJsonWithinByteLimit } from '../shared/node-bounded-json-stringify'
import { hardenExistingSecureFile, writeSecureFile } from '../shared/secure-file'
import { listEphemeralVmRuntimes } from '../shared/ephemeral-vm-runtime-store'
import { parseStrictUtf8Json } from '../shared/strict-json'

const JOURNAL_FILE = 'orca-environment-recipe-mutations.json'
const MAX_JOURNAL_FILE_BYTES = 512 * 1024
export const MAX_DURABLE_ENVIRONMENT_RECIPE_MUTATIONS = 256

const MutationIdentitySchema = z
  .object({
    pairedDeviceId: z.string().min(1),
    method: z.string().min(1),
    clientMutationId: z.string().min(1)
  })
  .strict()

const MutationEntrySchema = MutationIdentitySchema.extend({
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  provisionRef: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64}|\S+)$/),
  runtimeId: z.string().min(1),
  operatorRecipeCatalogSha256: z.string().regex(/^[0-9a-f]{64}$/),
  state: z.enum(['prepared', 'completed', 'terminal']),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite()
}).strict()

const MutationJournalSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(MutationEntrySchema).max(MAX_DURABLE_ENVIRONMENT_RECIPE_MUTATIONS)
  })
  .strict()

export type EnvironmentRecipeMutationIdentity = z.infer<typeof MutationIdentitySchema>
export type DurableEnvironmentRecipeMutation = z.infer<typeof MutationEntrySchema>

export class EnvironmentRecipeOperationJournalError extends Error {
  readonly code: 'capacity' | 'invalid'

  constructor(code: EnvironmentRecipeOperationJournalError['code']) {
    super(`Environment recipe mutation journal ${code}.`)
    this.name = 'EnvironmentRecipeOperationJournalError'
    this.code = code
  }
}

export function readDurableEnvironmentRecipeMutation(
  userDataPath: string,
  identity: EnvironmentRecipeMutationIdentity
): DurableEnvironmentRecipeMutation | null {
  return readJournal(userDataPath).entries.find((entry) => sameIdentity(entry, identity)) ?? null
}

export function prepareDurableEnvironmentRecipeMutation(
  userDataPath: string,
  entry: Omit<DurableEnvironmentRecipeMutation, 'state' | 'createdAt' | 'updatedAt'>,
  now = Date.now(),
  maxEntries = MAX_DURABLE_ENVIRONMENT_RECIPE_MUTATIONS
): DurableEnvironmentRecipeMutation {
  // Synchronous read-through-rename keeps the single host process's journal writers serialized.
  const journal = readJournal(userDataPath)
  const existing = journal.entries.find((candidate) => sameIdentity(candidate, entry))
  if (existing) {
    return existing
  }
  const runtimes = listEphemeralVmRuntimes(userDataPath)
  const retained = retainCapacityForPreparedEnvironmentRecipeMutation(
    journal.entries,
    maxEntries,
    (candidate) =>
      runtimes.some(
        (runtime) =>
          runtime.id === candidate.runtimeId &&
          runtime.provisionMutation?.requestSha256 === candidate.fingerprint &&
          runtime.provisionMutation.resolvedRef === candidate.provisionRef &&
          runtime.operatorRecipeCatalogSha256 === candidate.operatorRecipeCatalogSha256 &&
          (candidate.state === 'completed' ||
            runtime.status === 'cleaned' ||
            runtime.status === 'cleanup_failed')
      )
  )
  const prepared = MutationEntrySchema.parse({
    ...entry,
    state: 'prepared',
    createdAt: now,
    updatedAt: now
  })
  writeJournal(userDataPath, [...retained, prepared])
  return prepared
}

export function completeDurableEnvironmentRecipeMutation(
  userDataPath: string,
  identity: EnvironmentRecipeMutationIdentity,
  now = Date.now()
): void {
  const journal = readJournal(userDataPath)
  const existing = journal.entries.find((entry) => sameIdentity(entry, identity))
  if (!existing || existing.state !== 'prepared') {
    return
  }
  writeJournal(
    userDataPath,
    journal.entries.map((entry) =>
      sameIdentity(entry, identity)
        ? MutationEntrySchema.parse({ ...entry, state: 'completed', updatedAt: now })
        : entry
    )
  )
}

export function terminateDurableEnvironmentRecipeMutation(
  userDataPath: string,
  identity: EnvironmentRecipeMutationIdentity,
  now = Date.now()
): void {
  const journal = readJournal(userDataPath)
  const existing = journal.entries.find((entry) => sameIdentity(entry, identity))
  if (!existing || existing.state !== 'prepared') {
    return
  }
  writeJournal(
    userDataPath,
    journal.entries.map((entry) =>
      sameIdentity(entry, identity)
        ? MutationEntrySchema.parse({ ...entry, state: 'terminal', updatedAt: now })
        : entry
    )
  )
}

function readJournal(userDataPath: string): {
  version: 1
  entries: DurableEnvironmentRecipeMutation[]
} {
  const path = getEnvironmentRecipeOperationJournalPath(userDataPath)
  if (!existsSync(path)) {
    return { version: 1, entries: [] }
  }
  try {
    hardenExistingSecureFile(path)
    const journal = MutationJournalSchema.parse(
      parseStrictUtf8Json(readNodeFileSyncWithinLimit(path, MAX_JOURNAL_FILE_BYTES).buffer)
    )
    assertUniqueMutationIdentities(journal.entries)
    return journal
  } catch {
    throw new EnvironmentRecipeOperationJournalError('invalid')
  }
}

function assertUniqueMutationIdentities(entries: DurableEnvironmentRecipeMutation[]): void {
  const identities = new Set<string>()
  for (const entry of entries) {
    const identity = JSON.stringify([entry.pairedDeviceId, entry.method, entry.clientMutationId])
    if (identities.has(identity)) {
      throw new Error('Duplicate environment recipe mutation identity.')
    }
    identities.add(identity)
  }
}

function writeJournal(userDataPath: string, entries: DurableEnvironmentRecipeMutation[]): void {
  const serialized = stringifyJsonWithinByteLimit(
    MutationJournalSchema.parse({ version: 1, entries }),
    MAX_JOURNAL_FILE_BYTES
  ).serialized
  writeSecureFile(getEnvironmentRecipeOperationJournalPath(userDataPath), serialized, {
    durable: true
  })
}

export function retainCapacityForPreparedEnvironmentRecipeMutation(
  entries: DurableEnvironmentRecipeMutation[],
  maxEntries = MAX_DURABLE_ENVIRONMENT_RECIPE_MUTATIONS,
  isDurablyBacked: (entry: DurableEnvironmentRecipeMutation) => boolean = () => false
): DurableEnvironmentRecipeMutation[] {
  if (entries.length < maxEntries) {
    return entries
  }
  const evictable = entries
    .filter((entry) => entry.state !== 'prepared' && isDurablyBacked(entry))
    .sort((a, b) => a.updatedAt - b.updatedAt || a.createdAt - b.createdAt)[0]
  if (!evictable) {
    throw new EnvironmentRecipeOperationJournalError('capacity')
  }
  return entries.filter((entry) => entry !== evictable)
}

function sameIdentity(
  left: EnvironmentRecipeMutationIdentity,
  right: EnvironmentRecipeMutationIdentity
): boolean {
  return (
    left.pairedDeviceId === right.pairedDeviceId &&
    left.method === right.method &&
    left.clientMutationId === right.clientMutationId
  )
}

export function getEnvironmentRecipeOperationJournalPath(userDataPath: string): string {
  return join(userDataPath, JOURNAL_FILE)
}
