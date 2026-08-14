import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EnvironmentRecipeRuntime } from '../shared/environment-recipe-runtime-rpc'
import {
  environmentRecipeMutationRequestSha256,
  environmentRecipeMutationRuntimeId,
  resetEnvironmentRecipeOperationControlForTests,
  runIdempotentEnvironmentRecipeMutation,
  runSerializedEnvironmentRecipeRuntimeOperation
} from './environment-recipe-operation-control'

const profilePaths: string[] = []

function profilePath(): string {
  const path = mkdtempSync(join(tmpdir(), 'orca-recipe-profile-'))
  profilePaths.push(path)
  return path
}

function runtime(runtimeId: string): EnvironmentRecipeRuntime {
  return {
    runtimeId,
    repoId: 'repo-1',
    recipeId: 'recipe-1',
    checkoutMode: 'orca-worktree',
    status: 'running',
    lifecycle: { suspend: true, resume: true, destroy: true },
    createdAt: 1,
    updatedAt: 1,
    connectionType: 'orca-server',
    projectRoot: '/repo'
  }
}

afterEach(() => {
  resetEnvironmentRecipeOperationControlForTests()
  for (const path of profilePaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('environment recipe operation profile isolation', () => {
  it('hashes normalized request fields with a stable lowercase digest', () => {
    const first = environmentRecipeMutationRequestSha256({
      repoId: 'repo-1',
      clientMutationId: 'mutation-1',
      ref: undefined,
      branch: 'main'
    })
    const reordered = environmentRecipeMutationRequestSha256({
      branch: 'main',
      clientMutationId: 'mutation-1',
      repoId: 'repo-1'
    })

    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(reordered).toBe(first)
    expect(
      environmentRecipeMutationRequestSha256({
        branch: 'different',
        clientMutationId: 'mutation-1',
        repoId: 'repo-1'
      })
    ).not.toBe(first)
  })

  it('does not share dedupe promises or generated IDs across profiles', async () => {
    const [firstProfile, secondProfile] = [profilePath(), profilePath()]
    const params = { clientMutationId: 'same-mutation' }
    const first = runIdempotentEnvironmentRecipeMutation(
      firstProfile!,
      'same-device',
      'environmentRecipes.provision',
      params,
      async () => runtime('first')
    )
    const replay = runIdempotentEnvironmentRecipeMutation(
      join(firstProfile!, '.'),
      'same-device',
      'environmentRecipes.provision',
      params,
      async () => runtime('unexpected')
    )
    const second = runIdempotentEnvironmentRecipeMutation(
      secondProfile!,
      'same-device',
      'environmentRecipes.provision',
      params,
      async () => runtime('second')
    )

    expect(replay).toBe(first)
    expect(second).not.toBe(first)
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { runtimeId: 'first' },
      { runtimeId: 'second' }
    ])
    expect(
      environmentRecipeMutationRuntimeId(firstProfile!, 'same-device', 'same-mutation')
    ).not.toBe(environmentRecipeMutationRuntimeId(secondProfile!, 'same-device', 'same-mutation'))
  })

  it('does not serialize identical runtime IDs across profiles', async () => {
    const [firstProfile, secondProfile] = [profilePath(), profilePath()]
    const started: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const first = runSerializedEnvironmentRecipeRuntimeOperation(
      firstProfile!,
      'same-runtime',
      async () => {
        started.push('first')
        await firstGate
        return runtime('first')
      }
    )
    const second = runSerializedEnvironmentRecipeRuntimeOperation(
      secondProfile!,
      'same-runtime',
      async () => {
        started.push('second')
        return runtime('second')
      }
    )

    await expect(second).resolves.toMatchObject({ runtimeId: 'second' })
    expect(started).toEqual(['first', 'second'])
    releaseFirst()
    await expect(first).resolves.toMatchObject({ runtimeId: 'first' })
  })
})
