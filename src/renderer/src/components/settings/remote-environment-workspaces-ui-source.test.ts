import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = [
  './RemoteEnvironmentWorkspacesSection.tsx',
  './remote-environment-workspaces-copy.ts'
]
  .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
  .join('\n')

describe('remote environment workspaces desktop controls', () => {
  it('keeps old-host and destructive confirmation states visible', () => {
    expect(source).toContain('Update Orca on this host')
    expect(source).toContain('Destroy environment workspace?')
    expect(source).toContain('variant="destructive"')
  })

  it('never renders connection, path, or provider result fields', () => {
    expect(source).not.toContain('{runtime.adoption.expectedPath}')
    expect(source).not.toContain('{runtime.adoption.connectionId}')
    expect(source).not.toContain('recipeResult')
  })
})
