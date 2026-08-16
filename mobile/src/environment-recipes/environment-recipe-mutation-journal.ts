import AsyncStorage from '@react-native-async-storage/async-storage'
import { z } from 'zod'

const EntrySchema = z
  .object({
    repoId: z.string().min(1),
    recipeId: z.string().min(1),
    clientMutationId: z.string().min(1),
    workspaceName: z.string().min(1).optional()
  })
  .strict()

export type EnvironmentRecipeMutationJournalEntry = z.infer<typeof EntrySchema>

function key(hostId: string): string {
  return `orca.environment-recipe-mutation.v1:${hostId}`
}

export async function loadEnvironmentRecipeMutation(
  hostId: string
): Promise<EnvironmentRecipeMutationJournalEntry | null> {
  try {
    const value = await AsyncStorage.getItem(key(hostId))
    return value ? EntrySchema.parse(JSON.parse(value)) : null
  } catch {
    await AsyncStorage.removeItem(key(hostId)).catch(() => {})
    return null
  }
}

export function saveEnvironmentRecipeMutation(
  hostId: string,
  entry: EnvironmentRecipeMutationJournalEntry
): Promise<void> {
  return AsyncStorage.setItem(key(hostId), JSON.stringify(EntrySchema.parse(entry)))
}

export function clearEnvironmentRecipeMutation(hostId: string): Promise<void> {
  return AsyncStorage.removeItem(key(hostId))
}
