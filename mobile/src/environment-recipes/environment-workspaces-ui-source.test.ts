import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  new URL('../../app/h/[hostId]/environment-workspaces.tsx', import.meta.url),
  'utf8'
)

describe('mobile environment workspace controls', () => {
  it('keeps serialized actions and destructive confirmation', () => {
    expect(source).toContain('EnvironmentRecipeOperationGate')
    expect(source).toContain('Destroy environment workspace?')
    expect(source).toContain('destructive')
  })

  it('renders only credential-free runtime presentation fields', () => {
    expect(source).toContain('runtime.workspaceName ?? runtime.recipeId')
    expect(source).toContain("runtime.status.replaceAll('_', ' ')")
    expect(source).not.toContain('{runtime.adoption.expectedPath}')
    expect(source).not.toContain('{runtime.adoption.connectionId}')
    expect(source).not.toContain('runtime.recipeResult')
  })
})
