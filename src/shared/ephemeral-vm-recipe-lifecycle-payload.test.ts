import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { EphemeralVmRecipeResult } from './ephemeral-vm-recipes'
import type { EphemeralVmRecipeContext } from './ephemeral-vm-recipe-runner'
import {
  buildEphemeralVmRecipeLifecyclePayload,
  type EphemeralVmRecipeLifecycleMode
} from './ephemeral-vm-recipe-lifecycle-payload'

const CONTRACT_DIRECTORY = join(
  process.cwd(),
  'config',
  'contracts',
  'environment-recipes',
  'lifecycle',
  'v1'
)
const SOURCE_REVISION = '338bd227c12067ace0661d95f66ae4ecb5223a68'
const RECIPE_RESULT = {
  schemaVersion: 2,
  checkoutMode: 'provisioned-root',
  connection: {
    type: 'ssh',
    target: {
      label: 'Example VM',
      host: 'vm.example.test',
      port: 22,
      username: 'orca',
      hostKey: {
        type: 'sha256',
        fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
      }
    },
    projectRoot: '/workspace/example'
  }
} as const satisfies EphemeralVmRecipeResult

type ContractProperty = {
  type?: 'object' | 'string'
  const?: unknown
  enum?: unknown[]
}

type LifecycleContract = {
  properties: Record<string, ContractProperty>
  required: string[]
  additionalProperties: false
}

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(CONTRACT_DIRECTORY, relativePath), 'utf8'))
}

function matchesContractTopLevel(contract: LifecycleContract, value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  if (contract.required.some((property) => !(property in record))) {
    return false
  }
  if (Object.keys(record).some((property) => !(property in contract.properties))) {
    return false
  }
  return Object.entries(record).every(([property, propertyValue]) => {
    const rule = contract.properties[property]
    if (!rule) {
      return false
    }
    if (rule.const !== undefined && propertyValue !== rule.const) {
      return false
    }
    if (rule.enum && !rule.enum.includes(propertyValue)) {
      return false
    }
    if (rule.type === 'string' && typeof propertyValue !== 'string') {
      return false
    }
    return (
      rule.type !== 'object' ||
      Boolean(propertyValue && typeof propertyValue === 'object' && !Array.isArray(propertyValue))
    )
  })
}

function buildPayload(mode: EphemeralVmRecipeLifecycleMode, context: EphemeralVmRecipeContext) {
  return buildEphemeralVmRecipeLifecyclePayload({
    mode,
    recipe: { id: 'example-recipe' },
    context,
    recipeResult: RECIPE_RESULT
  })
}

describe('environment-recipe lifecycle envelope contract', () => {
  it.each(['suspend', 'resume', 'destroy'] as const)('builds the exact %s envelope', (mode) => {
    const context: EphemeralVmRecipeContext = {
      instanceId: 'instance-1',
      recipeId: 'context-recipe-id',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      workspaceName: 'Workspace One',
      repoPath: '/workspace/example'
    }
    const payload = buildPayload(mode, context)

    expect(Object.keys(payload)).toEqual([
      'schemaVersion',
      'mode',
      'recipeId',
      'instanceId',
      'projectId',
      'workspaceId',
      'workspaceName',
      'recipeResult'
    ])
    expect(payload).toStrictEqual({
      schemaVersion: 1,
      mode,
      recipeId: 'example-recipe',
      instanceId: 'instance-1',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      workspaceName: 'Workspace One',
      recipeResult: RECIPE_RESULT
    })
  })

  it('omits undefined optional context fields when serialized', () => {
    const payload = buildPayload('suspend', {
      recipeId: 'context-recipe-id',
      repoPath: '/workspace/example'
    })

    const serialized = JSON.stringify(payload)

    expect(serialized).not.toContain('instanceId')
    expect(serialized).not.toContain('projectId')
    expect(serialized).not.toContain('workspaceId')
    expect(serialized).not.toContain('workspaceName')
    expect(JSON.parse(serialized)).toStrictEqual({
      schemaVersion: 1,
      mode: 'suspend',
      recipeId: 'example-recipe',
      recipeResult: RECIPE_RESULT
    })
  })

  it('locks the exact canonical schema bytes to the source revision', () => {
    const schemaBytes = readFileSync(join(CONTRACT_DIRECTORY, 'schema.json'))
    const lock = readJson('schema.lock.json') as {
      lockVersion: number
      contract: string
      mediaType: string
      bytes: number
      sha256: string
      sourceRevision: string
    }

    expect(lock).toStrictEqual({
      lockVersion: 1,
      contract: 'schema.json',
      mediaType: 'application/schema+json',
      bytes: schemaBytes.byteLength,
      sha256: createHash('sha256').update(schemaBytes).digest('hex'),
      sourceRevision: SOURCE_REVISION
    })
  })

  it('keeps the committed schema aligned with the runtime envelope surface', () => {
    const contract = readJson('schema.json') as LifecycleContract
    const payload = buildPayload('resume', {
      recipeId: 'context-recipe-id',
      repoPath: '/workspace/example'
    })

    expect(contract.required).toEqual(['schemaVersion', 'mode', 'recipeId', 'recipeResult'])
    expect(contract.additionalProperties).toBe(false)
    expect(contract.properties.schemaVersion).toEqual({ const: 1 })
    expect(contract.properties.mode).toEqual({ enum: ['suspend', 'resume', 'destroy'] })
    expect(Object.keys(contract.properties)).toEqual([
      'schemaVersion',
      'mode',
      'recipeId',
      'instanceId',
      'projectId',
      'workspaceId',
      'workspaceName',
      'recipeResult'
    ])
    expect(matchesContractTopLevel(contract, JSON.parse(JSON.stringify(payload)))).toBe(true)
  })

  it.each(['fixtures/unknown-top-level-property.json', 'fixtures/direct-schema-v2-result.json'])(
    'rejects adversarial fixture %s as a lifecycle envelope',
    (fixture) => {
      const contract = readJson('schema.json') as LifecycleContract

      expect(matchesContractTopLevel(contract, readJson(fixture))).toBe(false)
    }
  )
})
