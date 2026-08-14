import { beforeEach, describe, expect, it, vi } from 'vitest'

const values = new Map<string, string>()

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => void values.set(key, value)),
    removeItem: vi.fn(async (key: string) => void values.delete(key))
  }
}))

import {
  clearEnvironmentRecipeMutation,
  loadEnvironmentRecipeMutation,
  saveEnvironmentRecipeMutation
} from './environment-recipe-mutation-journal'

describe('mobile environment recipe mutation journal', () => {
  beforeEach(() => values.clear())

  it('survives a client restart with only safe retry fields', async () => {
    const entry = {
      repoId: 'repo-1',
      recipeId: 'recipe-1',
      clientMutationId: 'durable-1',
      workspaceName: 'Cloud box'
    }
    await saveEnvironmentRecipeMutation('host-1', entry)

    await expect(loadEnvironmentRecipeMutation('host-1')).resolves.toEqual(entry)
    expect([...values.values()].join('')).not.toContain('credential')

    await clearEnvironmentRecipeMutation('host-1')
    await expect(loadEnvironmentRecipeMutation('host-1')).resolves.toBeNull()
  })
})
