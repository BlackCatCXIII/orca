import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeServiceModule from './ephemeral-vm-runtime-service'
import type * as RuntimeSshModule from './ephemeral-vm-runtime-ssh'
import {
  listEphemeralVmRuntimes,
  upsertEphemeralVmRuntime
} from '../shared/ephemeral-vm-runtime-store'
import type { Repo } from '../shared/repo-types'
import type { OperatorEnvironmentRecipeCatalog } from './operator-environment-recipe-catalog'
import { resolveEnvironmentRecipeProvisionRef } from './environment-recipe-provision-ref'
import {
  getEnvironmentRecipeOperationJournalPath,
  prepareDurableEnvironmentRecipeMutation
} from './environment-recipe-operation-journal'
import {
  environmentRecipeMutationRequestSha256,
  environmentRecipeMutationRuntimeId,
  runIdempotentEnvironmentRecipeMutation
} from './environment-recipe-operation-control'

const provisionMock = vi.hoisted(() => vi.fn())
const connectSshMock = vi.hoisted(() => vi.fn())

vi.mock('./ephemeral-vm-runtime-service', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeServiceModule>()),
  provisionEphemeralVmRuntime: provisionMock
}))

vi.mock('./ephemeral-vm-runtime-ssh', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeSshModule>()),
  connectRuntimeOwnedSshTarget: connectSshMock
}))

import {
  provisionEnvironmentRecipeForRpc,
  resetEnvironmentRecipeRpcStateForTests,
  type EnvironmentRecipeRuntimeRpcDependencies
} from './environment-recipe-runtime-rpc-service'

const recipe = {
  id: 'operator-box',
  name: 'Operator box',
  checkoutMode: 'provisioned-root' as const,
  create: '/operator/create'
}
const catalog: OperatorEnvironmentRecipeCatalog = {
  status: { enabled: true, digest: 'c'.repeat(64), recipeIds: [recipe.id] },
  listRecipes: () => [recipe],
  resolveRecipe: (id) => (id === recipe.id ? recipe : null)
}
const targetRepo: Repo = {
  id: 'repo-1',
  path: '/target/repo',
  displayName: 'target',
  badgeColor: '#000000',
  addedAt: 1,
  kind: 'git'
}

let userDataPath: string
let primaryUserDataPath: string
let aliasRoot: string | undefined

function dependencies(
  repo: Repo = targetRepo,
  resolveProvisionRef?: EnvironmentRecipeRuntimeRpcDependencies['resolveProvisionRef']
): EnvironmentRecipeRuntimeRpcDependencies {
  return {
    runtime: { listRepos: () => [repo] },
    userDataPath,
    pairedDeviceId: 'paired-device',
    getPluginRecipes: async () => [],
    operatorRecipeCatalog: catalog,
    resolveProvisionRef
  }
}

function persistOperatorRuntime(
  path: string,
  args: {
    runtimeId: string
    requestSha256?: string
    resolvedRef?: string
    catalogSha256?: string
  }
) {
  return upsertEphemeralVmRuntime(path, {
    id: args.runtimeId,
    repoId: targetRepo.id,
    recipeId: recipe.id,
    recipe,
    operatorRecipeCatalogSha256: args.catalogSha256 ?? catalog.status.digest,
    ...(args.requestSha256 && args.resolvedRef
      ? {
          provisionMutation: {
            requestSha256: args.requestSha256,
            resolvedRef: args.resolvedRef
          }
        }
      : {}),
    status: 'running',
    cleanupStatus: 'not_started',
    connectionMode: 'ssh',
    sshTargetId: 'runtime-ssh-pinned',
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
}

beforeEach(() => {
  primaryUserDataPath = mkdtempSync(join(tmpdir(), 'orca-operator-provision-ref-'))
  userDataPath = primaryUserDataPath
  aliasRoot = undefined
  resetEnvironmentRecipeRpcStateForTests()
  provisionMock.mockReset()
  connectSshMock.mockReset()
  provisionMock.mockImplementation(
    async (args: {
      runtimeId: string
      provisionMutation?: { requestSha256: string; resolvedRef: string }
    }) => {
      const runtime = persistOperatorRuntime(userDataPath, {
        runtimeId: args.runtimeId,
        requestSha256: args.provisionMutation?.requestSha256,
        resolvedRef: args.provisionMutation?.resolvedRef
      })
      return { ok: true, runtime, start: { ok: true } }
    }
  )
})

afterEach(() => {
  if (aliasRoot) {
    rmSync(aliasRoot, { recursive: true, force: true })
  }
  rmSync(primaryUserDataPath, { recursive: true, force: true })
})

function aliasUserDataPath(): string {
  aliasRoot = mkdtempSync(join(tmpdir(), 'orca-operator-provision-alias-'))
  const alias = join(aliasRoot, 'profile')
  symlinkSync(primaryUserDataPath, alias, process.platform === 'win32' ? 'junction' : 'dir')
  return alias
}

function prepareProvisionMutation(
  params: { clientMutationId: string } & Record<string, unknown>,
  runtimeId: string,
  state: 'prepared' | 'completed' = 'prepared'
): void {
  const identity = {
    pairedDeviceId: 'paired-device',
    method: 'environmentRecipes.provision',
    clientMutationId: params.clientMutationId
  }
  prepareDurableEnvironmentRecipeMutation(primaryUserDataPath, {
    ...identity,
    fingerprint: environmentRecipeMutationRequestSha256(params),
    provisionRef: 'a'.repeat(40),
    runtimeId,
    operatorRecipeCatalogSha256: catalog.status.digest
  })
  if (state === 'completed') {
    const path = getEnvironmentRecipeOperationJournalPath(primaryUserDataPath)
    const journal = JSON.parse(readFileSync(path, 'utf8')) as {
      version: 1
      entries: { clientMutationId: string; state: string }[]
    }
    const persisted = journal.entries.find(
      (entry) => entry.clientMutationId === params.clientMutationId
    )
    if (!persisted) {
      throw new Error('Prepared mutation fixture was not persisted.')
    }
    persisted.state = 'completed'
    writeFileSync(path, JSON.stringify(journal), 'utf8')
  }
}

describe('operator environment recipe provision ref service', () => {
  it.each([
    ['missing', null],
    ['request SHA mismatch', { requestSha256: 'e'.repeat(64) }],
    ['resolved ref mismatch', { resolvedRef: 'b'.repeat(40) }],
    ['catalog mismatch', { catalogSha256: 'd'.repeat(64) }]
  ])('fails closed for completed replay with %s backing', async (_name, mismatch) => {
    const params = {
      repoId: targetRepo.id,
      recipeId: recipe.id,
      clientMutationId: `completed-${_name}`
    }
    const runtimeId = `runtime-${params.clientMutationId}`
    const requestSha256 = environmentRecipeMutationRequestSha256(params)
    prepareProvisionMutation(params, runtimeId, 'completed')
    if (mismatch) {
      persistOperatorRuntime(primaryUserDataPath, {
        runtimeId,
        requestSha256,
        resolvedRef: 'a'.repeat(40),
        ...mismatch
      })
    }
    resetEnvironmentRecipeRpcStateForTests()
    const listRecipes = vi.fn(() => [recipe])
    const getPluginRecipes = vi.fn(async () => [recipe])

    await expect(
      Promise.resolve().then(() =>
        provisionEnvironmentRecipeForRpc(
          {
            ...dependencies(),
            getPluginRecipes,
            operatorRecipeCatalog: { ...catalog, listRecipes }
          },
          params
        )
      )
    ).rejects.toMatchObject({ code: 'environment_recipe_conflict' })
    expect(provisionMock).not.toHaveBeenCalled()
    expect(listRecipes).not.toHaveBeenCalled()
    expect(getPluginRecipes).not.toHaveBeenCalled()
    expect(connectSshMock).not.toHaveBeenCalled()
  })

  it('resumes a prepared mutation through a profile alias with its durable runtime ID', async () => {
    const params = {
      repoId: targetRepo.id,
      recipeId: recipe.id,
      clientMutationId: 'prepared-alias'
    }
    const runtimeId = environmentRecipeMutationRuntimeId(
      primaryUserDataPath,
      'paired-device',
      params.clientMutationId
    )
    const resolver = vi.fn()
    prepareProvisionMutation(params, runtimeId)
    resetEnvironmentRecipeRpcStateForTests()
    userDataPath = aliasUserDataPath()
    expect(
      environmentRecipeMutationRuntimeId(userDataPath, 'paired-device', params.clientMutationId)
    ).not.toBe(runtimeId)

    await expect(
      provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
    ).resolves.toMatchObject({ runtimeId })
    expect(resolver).not.toHaveBeenCalled()
    expect(provisionMock).toHaveBeenCalledOnce()
    expect(provisionMock).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeId, ref: 'a'.repeat(40) })
    )
    expect(listEphemeralVmRuntimes(primaryUserDataPath).map((runtime) => runtime.id)).toEqual([
      runtimeId
    ])
  })

  it('reuses a completed mutation through a profile alias without reprovisioning', async () => {
    const params = {
      repoId: targetRepo.id,
      recipeId: recipe.id,
      clientMutationId: 'completed-alias'
    }
    const resolver = vi.fn().mockResolvedValue('a'.repeat(40))
    const first = await provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
    resetEnvironmentRecipeRpcStateForTests()
    userDataPath = aliasUserDataPath()
    expect(
      environmentRecipeMutationRuntimeId(userDataPath, 'paired-device', params.clientMutationId)
    ).not.toBe(first.runtimeId)

    await expect(
      provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
    ).resolves.toMatchObject({ runtimeId: first.runtimeId })
    expect(provisionMock).toHaveBeenCalledOnce()
    expect(resolver).toHaveBeenCalledOnce()
    expect(connectSshMock).not.toHaveBeenCalled()
    expect(listEphemeralVmRuntimes(primaryUserDataPath)).toHaveLength(1)
  })

  it('finds an evicted completed replay binding through a profile alias', async () => {
    const params = {
      repoId: targetRepo.id,
      recipeId: recipe.id,
      clientMutationId: 'evicted-completed-alias'
    }
    const resolver = vi.fn().mockResolvedValue('a'.repeat(40))
    const first = await provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
    rmSync(getEnvironmentRecipeOperationJournalPath(primaryUserDataPath))
    resetEnvironmentRecipeRpcStateForTests()
    userDataPath = aliasUserDataPath()

    await expect(
      provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
    ).resolves.toMatchObject({ runtimeId: first.runtimeId })
    expect(provisionMock).toHaveBeenCalledOnce()
    expect(resolver).toHaveBeenCalledOnce()
    expect(listEphemeralVmRuntimes(primaryUserDataPath).map((runtime) => runtime.id)).toEqual([
      first.runtimeId
    ])
  })

  it.each(['prepared', 'completed'])(
    'fails closed for a legacy %s pin without a durable runtime ID',
    async (state) => {
      const params = {
        repoId: targetRepo.id,
        recipeId: recipe.id,
        clientMutationId: `missing-runtime-id-${state}`
      }
      writeFileSync(
        getEnvironmentRecipeOperationJournalPath(primaryUserDataPath),
        JSON.stringify({
          version: 1,
          entries: [
            {
              pairedDeviceId: 'paired-device',
              method: 'environmentRecipes.provision',
              clientMutationId: params.clientMutationId,
              fingerprint: environmentRecipeMutationRequestSha256(params),
              provisionRef: 'a'.repeat(40),
              operatorRecipeCatalogSha256: catalog.status.digest,
              state,
              createdAt: 1,
              updatedAt: 1
            }
          ]
        }),
        'utf8'
      )
      const listRecipes = vi.fn(() => [recipe])

      await expect(
        Promise.resolve().then(() =>
          provisionEnvironmentRecipeForRpc(
            {
              ...dependencies(),
              operatorRecipeCatalog: { ...catalog, listRecipes }
            },
            params
          )
        )
      ).rejects.toMatchObject({ code: 'environment_recipe_failed' })
      expect(listRecipes).not.toHaveBeenCalled()
      expect(provisionMock).not.toHaveBeenCalled()
      expect(connectSshMock).not.toHaveBeenCalled()
    }
  )

  it('replays the pinned ref after a side effect boundary crash and later runtime success', async () => {
    let head = 'a'.repeat(40)
    const gitExec = vi.fn(async () => ({ stdout: `${head}\n` }))
    const resolver = (args: Parameters<typeof resolveEnvironmentRecipeProvisionRef>[0]) =>
      resolveEnvironmentRecipeProvisionRef(args, gitExec)
    const params = {
      repoId: targetRepo.id,
      recipeId: recipe.id,
      clientMutationId: 'pin-head',
      workspaceName: 'Private workspace label'
    }
    provisionMock.mockImplementationOnce(async () => {
      throw new Error('crash after recipe invocation')
    })

    await expect(
      provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
    ).rejects.toMatchObject({ code: 'environment_recipe_failed' })
    expect(provisionMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ ref: 'a'.repeat(40), branch: undefined })
    )
    expect(
      readFileSync(getEnvironmentRecipeOperationJournalPath(userDataPath), 'utf8')
    ).not.toContain(params.workspaceName)

    resetEnvironmentRecipeRpcStateForTests()
    head = 'b'.repeat(40)
    await provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
    expect(gitExec).toHaveBeenCalledOnce()
    expect(provisionMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ ref: 'a'.repeat(40), branch: undefined })
    )

    resetEnvironmentRecipeRpcStateForTests()
    head = 'c'.repeat(40)
    await provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
    expect(gitExec).toHaveBeenCalledOnce()
    expect(provisionMock).toHaveBeenCalledTimes(2)
  })

  it('returns a rejected promise when the authoritative replay pre-read fails', async () => {
    const blockedUserDataPath = join(userDataPath, 'not-a-directory')
    writeFileSync(blockedUserDataPath, 'blocked', 'utf8')
    const resolver = vi.fn().mockResolvedValue('a'.repeat(40))

    const result = provisionEnvironmentRecipeForRpc(
      { ...dependencies(targetRepo, resolver), userDataPath: blockedUserDataPath },
      {
        repoId: targetRepo.id,
        recipeId: recipe.id,
        clientMutationId: 'replay-pre-read-failure'
      }
    )

    expect(result).toBeInstanceOf(Promise)
    await expect(result).rejects.toMatchObject({ code: 'environment_recipe_failed' })
    expect(resolver).not.toHaveBeenCalled()
    expect(provisionMock).not.toHaveBeenCalled()
  })

  it('fails closed before recipe invocation when the durable pin cannot be written', async () => {
    const resolver = vi.fn().mockImplementation(async () => {
      mkdirSync(getEnvironmentRecipeOperationJournalPath(userDataPath))
      return 'a'.repeat(40)
    })

    const result = provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), {
      repoId: targetRepo.id,
      recipeId: recipe.id,
      clientMutationId: 'journal-write-failure'
    })

    expect(result).toBeInstanceOf(Promise)
    await expect(result).rejects.toMatchObject({ code: 'environment_recipe_failed' })
    expect(resolver).toHaveBeenCalledOnce()
    expect(provisionMock).not.toHaveBeenCalled()
  })

  it('returns a rejected promise for an in-memory fingerprint conflict', async () => {
    const resolver = vi.fn(() => new Promise<string>(() => undefined))
    const params = {
      repoId: targetRepo.id,
      recipeId: recipe.id,
      clientMutationId: 'in-memory-fingerprint-conflict'
    }
    void provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)

    const conflict = provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), {
      ...params,
      branch: 'different'
    })

    expect(conflict).toBeInstanceOf(Promise)
    await expect(conflict).rejects.toMatchObject({ code: 'environment_recipe_conflict' })
    expect(provisionMock).not.toHaveBeenCalled()
  })

  it('returns a rejected promise when in-memory operation capacity is full', async () => {
    for (let index = 0; index < 256; index += 1) {
      void runIdempotentEnvironmentRecipeMutation(
        userDataPath,
        'capacity-device',
        'capacity-method',
        { clientMutationId: `capacity-${index}` },
        () => new Promise(() => undefined)
      )
    }

    const capacity = provisionEnvironmentRecipeForRpc(dependencies(), {
      repoId: targetRepo.id,
      recipeId: recipe.id,
      clientMutationId: 'capacity-public-boundary'
    })

    expect(capacity).toBeInstanceOf(Promise)
    await expect(capacity).rejects.toMatchObject({ code: 'environment_recipe_conflict' })
    expect(provisionMock).not.toHaveBeenCalled()
  })

  it('rejects prepared replay after the operator catalog changes', async () => {
    const resolver = vi.fn().mockResolvedValue('a'.repeat(40))
    const params = {
      repoId: targetRepo.id,
      recipeId: recipe.id,
      clientMutationId: 'catalog-change'
    }
    provisionMock.mockRejectedValueOnce(new Error('crash after recipe invocation'))

    await expect(
      provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
    ).rejects.toMatchObject({ code: 'environment_recipe_failed' })
    resetEnvironmentRecipeRpcStateForTests()
    const changedCatalog: OperatorEnvironmentRecipeCatalog = {
      ...catalog,
      status: { ...catalog.status, digest: 'd'.repeat(64) }
    }

    await expect(
      Promise.resolve().then(() =>
        provisionEnvironmentRecipeForRpc(
          { ...dependencies(targetRepo, resolver), operatorRecipeCatalog: changedCatalog },
          params
        )
      )
    ).rejects.toMatchObject({ code: 'environment_recipe_conflict' })
    expect(resolver).toHaveBeenCalledOnce()
    expect(provisionMock).toHaveBeenCalledOnce()
  })

  it('preserves an explicit ref and does not read HEAD', async () => {
    const gitExec = vi.fn()
    const resolver = (args: Parameters<typeof resolveEnvironmentRecipeProvisionRef>[0]) =>
      resolveEnvironmentRecipeProvisionRef(args, gitExec)

    await provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), {
      repoId: targetRepo.id,
      recipeId: recipe.id,
      clientMutationId: 'explicit-ref',
      ref: 'refs/tags/operator-release'
    })

    expect(provisionMock).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'refs/tags/operator-release' })
    )
    expect(gitExec).not.toHaveBeenCalled()
  })

  it('rejects conflicting reuse of a durable mutation identity after restart', async () => {
    const resolver = vi.fn().mockResolvedValue('a'.repeat(40))
    const params = {
      repoId: targetRepo.id,
      recipeId: recipe.id,
      clientMutationId: 'strict-conflict',
      workspaceName: 'first'
    }

    await provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
    resetEnvironmentRecipeRpcStateForTests()

    await expect(
      Promise.resolve().then(() =>
        provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), {
          ...params,
          workspaceName: 'different'
        })
      )
    ).rejects.toMatchObject({ code: 'environment_recipe_conflict' })
    expect(resolver).toHaveBeenCalledOnce()
    expect(provisionMock).toHaveBeenCalledOnce()
  })

  it('rejects replay after a recipe-start failure reached terminal cleanup', async () => {
    const resolver = vi.fn().mockResolvedValue('a'.repeat(40))
    const params = {
      repoId: targetRepo.id,
      recipeId: recipe.id,
      clientMutationId: 'terminal-start-failure'
    }
    provisionMock.mockImplementationOnce(
      async (args: {
        runtimeId: string
        provisionMutation: { requestSha256: string; resolvedRef: string }
        onTerminalProvisionFailure?: () => void
      }) => {
        const runtime = persistOperatorRuntime(userDataPath, {
          runtimeId: args.runtimeId,
          requestSha256: args.provisionMutation.requestSha256,
          resolvedRef: args.provisionMutation.resolvedRef
        })
        upsertEphemeralVmRuntime(userDataPath, {
          ...runtime,
          status: 'cleaned',
          cleanupStatus: 'succeeded'
        })
        args.onTerminalProvisionFailure?.()
        return { ok: false, start: { ok: false, error: 'start failed', recipeResult: {} } }
      }
    )

    await expect(
      Promise.resolve().then(() =>
        provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
      )
    ).rejects.toMatchObject({ code: 'environment_recipe_failed' })

    await expect(
      Promise.resolve().then(() =>
        provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
      )
    ).rejects.toMatchObject({
      code: 'environment_recipe_conflict',
      message: expect.stringContaining('new attempt')
    })
    resetEnvironmentRecipeRpcStateForTests()
    await expect(
      Promise.resolve().then(() =>
        provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
      )
    ).rejects.toMatchObject({
      code: 'environment_recipe_conflict',
      message: expect.stringContaining('new attempt')
    })
    resetEnvironmentRecipeRpcStateForTests()
    await expect(
      Promise.resolve().then(() =>
        provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), {
          ...params,
          workspaceName: 'conflicting terminal reuse'
        })
      )
    ).rejects.toMatchObject({
      code: 'environment_recipe_conflict',
      message: expect.stringContaining('different recipe request')
    })
    expect(resolver).toHaveBeenCalledOnce()
    expect(provisionMock).toHaveBeenCalledOnce()
  })

  it('uses runtime bindings for strict replay after completed journal retention', async () => {
    const resolver = vi.fn().mockResolvedValue('a'.repeat(40))
    const params = {
      repoId: targetRepo.id,
      recipeId: recipe.id,
      clientMutationId: 'runtime-binding'
    }

    await provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
    rmSync(getEnvironmentRecipeOperationJournalPath(userDataPath))
    resetEnvironmentRecipeRpcStateForTests()

    await expect(
      provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
    ).resolves.toMatchObject({ repoId: targetRepo.id, recipeId: recipe.id })
    resetEnvironmentRecipeRpcStateForTests()
    await expect(
      provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), {
        ...params,
        ref: 'b'.repeat(40)
      })
    ).rejects.toMatchObject({ code: 'environment_recipe_conflict' })
    resetEnvironmentRecipeRpcStateForTests()
    await expect(
      provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), {
        ...params,
        branch: 'moved-branch'
      })
    ).rejects.toMatchObject({ code: 'environment_recipe_conflict' })
    expect(resolver).toHaveBeenCalledOnce()
    expect(provisionMock).toHaveBeenCalledOnce()
  })

  it('uses a cleaned runtime tombstone after terminal journal retention', async () => {
    const resolver = vi.fn().mockResolvedValue('a'.repeat(40))
    const params = {
      repoId: targetRepo.id,
      recipeId: recipe.id,
      clientMutationId: 'terminal-runtime-binding'
    }
    provisionMock.mockImplementationOnce(
      async (args: {
        runtimeId: string
        provisionMutation: { requestSha256: string; resolvedRef: string }
        onTerminalProvisionFailure: () => void
      }) => {
        upsertEphemeralVmRuntime(userDataPath, {
          id: args.runtimeId,
          repoId: targetRepo.id,
          recipeId: recipe.id,
          recipe,
          operatorRecipeCatalogSha256: catalog.status.digest,
          provisionMutation: args.provisionMutation,
          status: 'cleaned',
          cleanupStatus: 'succeeded',
          connectionMode: 'ssh',
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
        args.onTerminalProvisionFailure()
        return { ok: false, start: { ok: false, error: 'start failed', recipeResult: {} } }
      }
    )

    await expect(
      provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
    ).rejects.toMatchObject({ code: 'environment_recipe_failed' })
    rmSync(getEnvironmentRecipeOperationJournalPath(userDataPath))
    resetEnvironmentRecipeRpcStateForTests()

    await expect(
      provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), params)
    ).rejects.toMatchObject({
      code: 'environment_recipe_conflict',
      message: expect.stringContaining('new attempt')
    })
    resetEnvironmentRecipeRpcStateForTests()
    await expect(
      provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), {
        ...params,
        branch: 'conflict'
      })
    ).rejects.toMatchObject({ code: 'environment_recipe_conflict' })
    expect(resolver).toHaveBeenCalledOnce()
    expect(provisionMock).toHaveBeenCalledOnce()
  })

  it('leaves missing-ref nonoperator provisioning unchanged', async () => {
    const resolver = vi.fn().mockResolvedValue(undefined)
    const deps = {
      ...dependencies(targetRepo, resolver),
      operatorRecipeCatalog: undefined,
      getPluginRecipes: async () => [recipe]
    }

    await provisionEnvironmentRecipeForRpc(deps, {
      repoId: targetRepo.id,
      recipeId: recipe.id,
      clientMutationId: 'legacy-missing-ref'
    })

    expect(provisionMock).toHaveBeenCalledWith(
      expect.objectContaining({ ref: undefined, branch: undefined, executionMode: 'shell' })
    )
  })

  it.each(['missing', 'unborn', 'ambiguous', 'noncommit', 'vanished'])(
    'fails before recipe invocation when target HEAD is %s',
    async (state) => {
      const resolver = vi.fn().mockRejectedValue(new Error(`${state} HEAD`))

      await expect(
        provisionEnvironmentRecipeForRpc(dependencies(targetRepo, resolver), {
          repoId: targetRepo.id,
          recipeId: recipe.id,
          clientMutationId: `invalid-head-${state}`
        })
      ).rejects.toMatchObject({ code: 'environment_recipe_failed' })
      expect(provisionMock).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['folder', { ...targetRepo, kind: 'folder' as const }],
    ['remote', { ...targetRepo, connectionId: 'remote-target' }]
  ])('rejects an ineligible %s target before ref resolution', async (_name, repo) => {
    const resolver = vi.fn()

    await expect(
      provisionEnvironmentRecipeForRpc(dependencies(repo, resolver), {
        repoId: repo.id,
        recipeId: recipe.id,
        clientMutationId: `ineligible-${_name}`
      })
    ).rejects.toMatchObject({ code: 'environment_recipe_not_found' })
    expect(resolver).not.toHaveBeenCalled()
    expect(provisionMock).not.toHaveBeenCalled()
  })
})
