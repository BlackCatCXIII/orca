import { z } from 'zod'

const EntrySchema = z
  .object({
    repoId: z.string().min(1),
    recipeId: z.string().min(1),
    clientMutationId: z.string().min(1),
    workspaceName: z.string().min(1).optional()
  })
  .strict()

export type DesktopEnvironmentRecipeMutation = z.infer<typeof EntrySchema>

const PREFIX = 'orca.environment-recipe-mutation.v1:'

export function loadDesktopEnvironmentRecipeMutation(
  environmentId: string
): DesktopEnvironmentRecipeMutation | null {
  try {
    const raw = localStorage.getItem(`${PREFIX}${environmentId}`)
    return raw ? EntrySchema.parse(JSON.parse(raw)) : null
  } catch {
    localStorage.removeItem(`${PREFIX}${environmentId}`)
    return null
  }
}

export function saveDesktopEnvironmentRecipeMutation(
  environmentId: string,
  entry: DesktopEnvironmentRecipeMutation
): void {
  localStorage.setItem(`${PREFIX}${environmentId}`, JSON.stringify(EntrySchema.parse(entry)))
}

export function clearDesktopEnvironmentRecipeMutation(environmentId: string): void {
  localStorage.removeItem(`${PREFIX}${environmentId}`)
}
