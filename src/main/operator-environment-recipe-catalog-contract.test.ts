import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CONTRACT_ROOT = join(
  process.cwd(),
  'config',
  'contracts',
  'environment-recipes',
  'operator-catalog',
  'v1'
)

describe('operator environment recipe catalog contract', () => {
  it('locks the exact canonical schema bytes', () => {
    const schemaBytes = readFileSync(join(CONTRACT_ROOT, 'schema.json'))
    const lock = JSON.parse(readFileSync(join(CONTRACT_ROOT, 'schema.lock.json'), 'utf8'))

    expect(lock).toEqual({
      lockVersion: 1,
      contract: 'schema.json',
      mediaType: 'application/schema+json',
      bytes: schemaBytes.byteLength,
      sha256: createHash('sha256').update(schemaBytes).digest('hex')
    })
  })

  it('keeps the versioned schema strict and provisioned-root only', () => {
    const schema = JSON.parse(readFileSync(join(CONTRACT_ROOT, 'schema.json'), 'utf8'))

    expect(schema.required).toEqual(['schemaVersion', 'recipes'])
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties.schemaVersion).toEqual({ const: 1 })
    expect(schema.properties.recipes.maxItems).toBe(32)
    expect(schema.$defs.recipe.properties.checkoutMode).toEqual({ const: 'provisioned-root' })
    expect(schema.$defs.recipe.additionalProperties).toBe(false)
    expect(schema.$defs.lifecycle.additionalProperties).toBe(false)
    expect(schema.$defs.script.additionalProperties).toBe(false)
  })
})
