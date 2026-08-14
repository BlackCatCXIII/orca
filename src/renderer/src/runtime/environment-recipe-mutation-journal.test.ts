import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearDesktopEnvironmentRecipeMutation,
  loadDesktopEnvironmentRecipeMutation,
  saveDesktopEnvironmentRecipeMutation
} from './environment-recipe-mutation-journal'

describe('desktop environment recipe mutation journal', () => {
  beforeEach(() => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    })
  })

  it('reuses the provision key after restart and rejects extra sensitive fields', () => {
    const entry = {
      repoId: 'repo-1',
      recipeId: 'recipe-1',
      clientMutationId: 'durable-1',
      workspaceName: 'Cloud box'
    }
    saveDesktopEnvironmentRecipeMutation('environment-1', entry)
    expect(loadDesktopEnvironmentRecipeMutation('environment-1')).toEqual(entry)

    localStorage.setItem(
      'orca.environment-recipe-mutation.v1:environment-1',
      JSON.stringify({ ...entry, identityFile: '/secret/key' })
    )
    expect(loadDesktopEnvironmentRecipeMutation('environment-1')).toBeNull()

    clearDesktopEnvironmentRecipeMutation('environment-1')
  })
})
