import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaVmRecipe } from '../shared/orca-yaml-hook-types'
import {
  resolveEnvironmentRecipeRuntimeScope,
  resolveEnvironmentRecipes
} from './environment-recipe-scope'
import type { OperatorEnvironmentRecipeCatalog } from './operator-environment-recipe-catalog'
import { upsertEphemeralVmRuntime } from '../shared/ephemeral-vm-runtime-store'

const roots: string[] = []
const operatorRecipe: OrcaVmRecipe = {
  id: 'same-id',
  name: 'Operator recipe',
  checkoutMode: 'provisioned-root',
  create: '/operator/create'
}
const operatorCatalog: OperatorEnvironmentRecipeCatalog = {
  status: { enabled: true, digest: 'a'.repeat(64), recipeIds: ['same-id'] },
  listRecipes: () => [operatorRecipe],
  resolveRecipe: (id) => (id === operatorRecipe.id ? operatorRecipe : null)
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function repoFixture() {
  const path = mkdtempSync(join(tmpdir(), 'orca-operator-shadow-'))
  roots.push(path)
  mkdirSync(join(path, '.git'))
  writeFileSync(
    join(path, 'orca.yaml'),
    [
      'environmentRecipes:',
      '  - id: same-id',
      '    name: Target shadow',
      '    checkoutMode: provisioned-root',
      '    create: target-secret-reader'
    ].join('\n')
  )
  return {
    id: 'target-repo',
    path,
    displayName: 'target',
    badgeColor: '#000000',
    addedAt: 1,
    kind: 'git' as const
  }
}

describe('operator environment recipe scope', () => {
  it('ignores target-repo and plugin same-id shadows while preserving nonoperator behavior', async () => {
    const repo = repoFixture()
    const pluginRecipe = {
      ...operatorRecipe,
      name: 'Plugin shadow',
      create: 'plugin-secret-reader'
    }
    const getPluginRecipes = vi.fn(async () => [pluginRecipe])

    await expect(
      resolveEnvironmentRecipes(repo, getPluginRecipes, operatorCatalog)
    ).resolves.toEqual([operatorRecipe])
    expect(getPluginRecipes).not.toHaveBeenCalled()

    const nonoperator = await resolveEnvironmentRecipes(repo, getPluginRecipes)
    expect(nonoperator.map((recipe) => recipe.create)).toContain('target-secret-reader')
  })

  it('rejects a persisted same-id runtime that was not created by the operator catalog', async () => {
    const repo = repoFixture()
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-operator-runtime-shadow-'))
    roots.push(userDataPath)
    upsertEphemeralVmRuntime(userDataPath, {
      id: 'runtime-shadow',
      repoId: repo.id,
      recipeId: 'same-id',
      recipe: { ...operatorRecipe, create: 'target-secret-reader' },
      status: 'running',
      cleanupStatus: 'not_started',
      createdAt: 1,
      updatedAt: 1,
      recipeResult: {
        schemaVersion: 2,
        checkoutMode: 'provisioned-root',
        connection: {
          type: 'ssh',
          projectRoot: '/srv/repo',
          target: {
            label: 'host',
            host: 'host',
            port: 22,
            username: 'root',
            hostKey: { type: 'sha256', fingerprint: `SHA256:${'A'.repeat(43)}` }
          }
        }
      }
    })

    await expect(
      resolveEnvironmentRecipeRuntimeScope(
        {
          runtime: { listRepos: () => [repo] },
          userDataPath,
          getPluginRecipes: async () => [],
          operatorRecipeCatalog: operatorCatalog
        },
        { repoId: repo.id, recipeId: 'same-id', runtimeId: 'runtime-shadow' }
      )
    ).rejects.toMatchObject({ code: 'environment_recipe_not_found' })
  })

  it('requires the persisted exact catalog identity across lifecycle restarts', async () => {
    const repo = repoFixture()
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-operator-runtime-identity-'))
    roots.push(userDataPath)
    const record = {
      id: 'runtime-operator',
      repoId: repo.id,
      recipeId: operatorRecipe.id,
      recipe: operatorRecipe,
      operatorRecipeCatalogSha256: operatorCatalog.status.digest,
      status: 'running' as const,
      cleanupStatus: 'not_started' as const,
      createdAt: 1,
      updatedAt: 1,
      recipeResult: {
        schemaVersion: 2 as const,
        checkoutMode: 'provisioned-root' as const,
        connection: {
          type: 'ssh' as const,
          projectRoot: '/srv/repo',
          target: {
            label: 'host',
            host: 'host',
            port: 22,
            username: 'root',
            hostKey: { type: 'sha256' as const, fingerprint: `SHA256:${'A'.repeat(43)}` }
          }
        }
      }
    }
    upsertEphemeralVmRuntime(userDataPath, record)
    const context = {
      runtime: { listRepos: () => [repo] },
      userDataPath,
      getPluginRecipes: async () => []
    }
    const scope = { repoId: repo.id, recipeId: operatorRecipe.id, runtimeId: record.id }

    await expect(
      resolveEnvironmentRecipeRuntimeScope(
        { ...context, operatorRecipeCatalog: operatorCatalog },
        scope
      )
    ).resolves.toMatchObject({ recipe: operatorRecipe })
    await expect(resolveEnvironmentRecipeRuntimeScope(context, scope)).rejects.toMatchObject({
      code: 'environment_recipe_not_found'
    })
    await expect(
      resolveEnvironmentRecipeRuntimeScope(
        {
          ...context,
          operatorRecipeCatalog: {
            ...operatorCatalog,
            status: { ...operatorCatalog.status, digest: 'b'.repeat(64) }
          }
        },
        scope
      )
    ).rejects.toMatchObject({ code: 'environment_recipe_not_found' })
  })
})
