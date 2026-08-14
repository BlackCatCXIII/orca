import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'
import type { AdoptProvisionedRootArgs } from '../shared/worktree/create-types'
import type { WorktreeMeta } from '../shared/worktree/meta-types'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import {
  listEphemeralVmRuntimes,
  upsertEphemeralVmRuntime
} from '../shared/ephemeral-vm-runtime-store'
import { registerSshGitProvider, unregisterSshGitProvider } from './providers/ssh-git-dispatch'
import {
  resetSshProviderAuthorities,
  rotateSshProviderAuthority
} from './ssh/ssh-provider-authority'
import { adoptProvisionedRootSshCheckout } from './provisioned-root-ssh-adoption'
import { OrcaRuntimeService } from './runtime/orca-runtime'

const connectionId = 'runtime-ssh-test'
const projectRoot = '/workspace/orca'

describe('adoptProvisionedRootSshCheckout', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-provisioned-root-'))
    resetSshProviderAuthorities()
  })

  afterEach(() => {
    unregisterSshGitProvider(connectionId)
    resetSshProviderAuthorities()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('adopts the exact primary checkout, persists host metadata, and attaches the runtime', async () => {
    seedRuntime(userDataPath, projectRoot)
    registerSshGitProvider(connectionId, {
      listWorktrees: vi.fn().mockResolvedValue([gitWorktree(projectRoot)]),
      exec: sparseCheckoutProbe(false)
    } as never)
    const { store, setWorktreeMeta } = makeStore()

    const adoption = await adoptProvisionedRootSshCheckout({
      userDataPath,
      request: request(projectRoot),
      repo: repo(projectRoot),
      store,
      isRepoCurrent: () => true
    })

    expect(adoption.created).toBe(true)
    expect(adoption.result.worktree).toMatchObject({
      id: `repo-1::${projectRoot}`,
      path: projectRoot,
      isMainWorktree: true,
      hostId: `ssh:${connectionId}`,
      ephemeralVmCheckoutMode: 'provisioned-root',
      linkedGitLabIssue: 17
    })
    expect(setWorktreeMeta).toHaveBeenCalledWith(
      `repo-1::${projectRoot}`,
      expect.objectContaining({
        hostId: `ssh:${connectionId}`,
        ephemeralVmCheckoutMode: 'provisioned-root',
        linkedGitLabIssue: 17
      })
    )
    expect(listEphemeralVmRuntimes(userDataPath)[0]).toMatchObject({
      workspaceId: `repo-1::${projectRoot}`,
      status: 'running'
    })
  })

  it('rejects a linked worktree and sparse checkout', async () => {
    seedRuntime(userDataPath, projectRoot)
    const listWorktrees = vi
      .fn()
      .mockResolvedValue([gitWorktree(projectRoot, { isMainWorktree: false })])
    registerSshGitProvider(connectionId, {
      listWorktrees,
      exec: sparseCheckoutProbe(false)
    } as never)
    const { store, setWorktreeMeta } = makeStore()

    await expect(
      adoptProvisionedRootSshCheckout({
        userDataPath,
        request: request(projectRoot),
        repo: repo(projectRoot),
        store,
        isRepoCurrent: () => true
      })
    ).rejects.toThrow('must be the repository primary checkout')
    await expect(
      adoptProvisionedRootSshCheckout({
        userDataPath,
        request: { ...request(projectRoot), sparseCheckout: { directories: ['src'] } },
        repo: repo(projectRoot),
        store,
        isRepoCurrent: () => true
      })
    ).rejects.toThrow('do not support sparse checkout')
    expect(setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('rejects path and runtime target mismatches', async () => {
    seedRuntime(userDataPath, projectRoot)
    registerSshGitProvider(connectionId, {
      listWorktrees: vi.fn().mockResolvedValue([gitWorktree(projectRoot)]),
      exec: sparseCheckoutProbe(false)
    } as never)
    const { store } = makeStore()

    await expect(
      adoptProvisionedRootSshCheckout({
        userDataPath,
        request: request('/workspace/other'),
        repo: repo(projectRoot),
        store,
        isRepoCurrent: () => true
      })
    ).rejects.toThrow('does not match')
    await expect(
      adoptProvisionedRootSshCheckout({
        userDataPath,
        request: { ...request(projectRoot), executionHostId: 'ssh:runtime-ssh-other' },
        repo: repo(projectRoot),
        store,
        isRepoCurrent: () => true
      })
    ).rejects.toThrow('host does not match')
  })

  it('rejects provider rotation during verification', async () => {
    seedRuntime(userDataPath, projectRoot)
    let resolveList: (value: ReturnType<typeof gitWorktree>[]) => void = () => undefined
    const listWorktrees = vi.fn(
      () =>
        new Promise<ReturnType<typeof gitWorktree>[]>((resolve) => {
          resolveList = resolve
        })
    )
    registerSshGitProvider(connectionId, {
      listWorktrees,
      exec: sparseCheckoutProbe(false)
    } as never)
    const { store } = makeStore()
    const adoption = adoptProvisionedRootSshCheckout({
      userDataPath,
      request: request(projectRoot),
      repo: repo(projectRoot),
      store,
      isRepoCurrent: () => true
    })
    await vi.waitFor(() => expect(listWorktrees).toHaveBeenCalledOnce())
    rotateSshProviderAuthority(connectionId)
    resolveList([gitWorktree(projectRoot)])

    await expect(adoption).rejects.toThrow('changed during checkout verification')
  })

  it('compares Windows checkout roots using runtime path semantics', async () => {
    const windowsRoot = 'C:\\Workspace\\Orca'
    seedRuntime(userDataPath, windowsRoot)
    registerSshGitProvider(connectionId, {
      listWorktrees: vi.fn().mockResolvedValue([gitWorktree('c:/workspace/orca/')]),
      exec: sparseCheckoutProbe(false)
    } as never)
    const { store } = makeStore({ repos: [repo('c:\\workspace\\orca')] })

    const adoption = await adoptProvisionedRootSshCheckout({
      userDataPath,
      request: request('C:/WORKSPACE/ORCA'),
      repo: repo('c:\\workspace\\orca'),
      store,
      isRepoCurrent: () => true
    })

    expect(adoption.result.worktree.path).toBe('c:/workspace/orca/')
  })

  it('rejects sparse checkout enabled in the remote Git config', async () => {
    seedRuntime(userDataPath, projectRoot)
    const exec = sparseCheckoutProbe(true)
    registerSshGitProvider(connectionId, {
      listWorktrees: vi.fn().mockResolvedValue([gitWorktree(projectRoot)]),
      exec
    } as never)
    const { store, setWorktreeMeta } = makeStore()

    await expect(
      adoptProvisionedRootSshCheckout({
        userDataPath,
        request: request(projectRoot),
        repo: repo(projectRoot),
        store,
        isRepoCurrent: () => true
      })
    ).rejects.toThrow('cannot adopt a sparse checkout')
    expect(exec).toHaveBeenCalledWith(
      ['config', '--bool', '--get', '--default=false', 'core.sparseCheckout'],
      projectRoot
    )
    expect(setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('returns an exact durable replay without rewriting attachment or metadata', async () => {
    const worktreeId = `repo-1::${projectRoot}`
    seedRuntime(userDataPath, projectRoot, { workspaceId: worktreeId })
    registerSshGitProvider(connectionId, {
      listWorktrees: vi.fn().mockResolvedValue([gitWorktree(projectRoot)]),
      exec: sparseCheckoutProbe(false)
    } as never)
    const durableMeta = worktreeMeta({
      instanceId: 'instance-stable',
      hostId: `ssh:${connectionId}`,
      ephemeralVmCheckoutMode: 'provisioned-root',
      createdAt: 10,
      orcaCreatedAt: 11,
      lastActivityAt: 12
    })
    const { store, setWorktreeMeta } = makeStore({
      initialMeta: { [worktreeId]: durableMeta }
    })
    const before = listEphemeralVmRuntimes(userDataPath)[0]

    const adoption = await adoptProvisionedRootSshCheckout({
      userDataPath,
      request: request(projectRoot),
      repo: repo(projectRoot),
      store,
      isRepoCurrent: () => true
    })

    expect(adoption.created).toBe(false)
    expect(adoption.result.worktree).toMatchObject({
      id: worktreeId,
      instanceId: 'instance-stable',
      createdAt: 10,
      lastActivityAt: 12
    })
    expect(setWorktreeMeta).not.toHaveBeenCalled()
    expect(listEphemeralVmRuntimes(userDataPath)[0]).toEqual(before)
  })

  it('rejects source, attachment, and imported-repo ambiguity before mutation', async () => {
    const listWorktrees = vi.fn().mockResolvedValue([gitWorktree(projectRoot)])
    seedRuntime(userDataPath, projectRoot, { workspaceId: 'other-repo::/other' })
    registerSshGitProvider(connectionId, {
      listWorktrees,
      exec: sparseCheckoutProbe(false)
    } as never)
    const ambiguousStores = [
      makeStore({
        repos: [repo(projectRoot), { ...repo(projectRoot), id: 'repo-duplicate' }]
      }),
      makeStore({
        repos: [repo(projectRoot), { ...repo('/workspace/other'), id: 'repo-1' }]
      })
    ]
    for (const ambiguous of ambiguousStores) {
      await expect(
        adoptProvisionedRootSshCheckout({
          userDataPath,
          request: request(projectRoot),
          repo: repo(projectRoot),
          store: ambiguous.store,
          isRepoCurrent: () => true
        })
      ).rejects.toThrow('ambiguous')
      expect(ambiguous.setWorktreeMeta).not.toHaveBeenCalled()
    }
    expect(listWorktrees).not.toHaveBeenCalled()

    const unique = makeStore()
    await expect(
      adoptProvisionedRootSshCheckout({
        userDataPath,
        request: { ...request(projectRoot), sourceRepoId: 'wrong-repo' },
        repo: repo(projectRoot),
        store: unique.store,
        isRepoCurrent: () => true
      })
    ).rejects.toThrow('does not match the runtime identity')
    expect(unique.setWorktreeMeta).not.toHaveBeenCalled()

    const wrongProject = makeStore({ sourceRepoIds: ['other-repo'] })
    await expect(
      adoptProvisionedRootSshCheckout({
        userDataPath,
        request: request(projectRoot),
        repo: repo(projectRoot),
        store: wrongProject.store,
        isRepoCurrent: () => true
      })
    ).rejects.toThrow('does not match the imported repo identity')
    expect(wrongProject.setWorktreeMeta).not.toHaveBeenCalled()

    await expect(
      adoptProvisionedRootSshCheckout({
        userDataPath,
        request: request(projectRoot),
        repo: repo(projectRoot),
        store: unique.store,
        isRepoCurrent: () => true
      })
    ).rejects.toThrow('already attached to another workspace')
    expect(unique.setWorktreeMeta).not.toHaveBeenCalled()

    seedRuntime(userDataPath, projectRoot)
    const worktreeId = `repo-1::${projectRoot}`
    const conflictingMeta = makeStore({
      initialMeta: {
        [worktreeId]: worktreeMeta({
          hostId: 'ssh:runtime-ssh-other',
          ephemeralVmCheckoutMode: 'provisioned-root'
        })
      }
    })
    await expect(
      adoptProvisionedRootSshCheckout({
        userDataPath,
        request: request(projectRoot),
        repo: repo(projectRoot),
        store: conflictingMeta.store,
        isRepoCurrent: () => true
      })
    ).rejects.toThrow('metadata belongs to another workspace')
    expect(conflictingMeta.setWorktreeMeta).not.toHaveBeenCalled()

    const sourceRuntime = listEphemeralVmRuntimes(userDataPath)[0]!
    upsertEphemeralVmRuntime(userDataPath, {
      ...sourceRuntime,
      id: 'runtime-2',
      workspaceId: worktreeId
    })
    const unattachedMeta = makeStore()
    await expect(
      adoptProvisionedRootSshCheckout({
        userDataPath,
        request: request(projectRoot),
        repo: repo(projectRoot),
        store: unattachedMeta.store,
        isRepoCurrent: () => true
      })
    ).rejects.toThrow('already attached to another runtime')
    expect(unattachedMeta.setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('uses the injected profile and replays safely after a runtime restart', async () => {
    const otherProfile = mkdtempSync(join(tmpdir(), 'orca-provisioned-root-other-'))
    try {
      seedRuntime(userDataPath, projectRoot)
      seedRuntime(otherProfile, projectRoot, { repoId: 'other-source-repo' })
      registerSshGitProvider(connectionId, {
        listWorktrees: vi.fn().mockResolvedValue([gitWorktree(projectRoot)]),
        exec: sparseCheckoutProbe(false)
      } as never)
      const { store } = makeStore()
      const firstRuntime = new OrcaRuntimeService(store)
      const firstEvents: unknown[] = []
      firstRuntime.onWorktreeLifecycle((event) => firstEvents.push(event))

      const first = await firstRuntime.adoptManagedProvisionedRoot({
        repoId: 'repo-1',
        userDataPath,
        request: request(projectRoot),
        activate: false
      })
      const durableMeta = store.getWorktreeMeta(first.worktree.id)
      const durableRuntime = listEphemeralVmRuntimes(userDataPath)[0]
      expect(firstEvents).toHaveLength(1)

      const restarted = new OrcaRuntimeService(store)
      const replayEvents: unknown[] = []
      restarted.onWorktreeLifecycle((event) => replayEvents.push(event))
      await expect(
        restarted.adoptManagedProvisionedRoot({
          repoId: 'repo-1',
          userDataPath,
          request: request(projectRoot),
          activate: false
        })
      ).resolves.toMatchObject({ worktree: { id: first.worktree.id } })
      expect(store.getWorktreeMeta(first.worktree.id)).toEqual(durableMeta)
      expect(listEphemeralVmRuntimes(userDataPath)[0]).toEqual(durableRuntime)
      expect(replayEvents).toEqual([])

      await expect(
        restarted.adoptManagedProvisionedRoot({
          repoId: 'repo-1',
          userDataPath: otherProfile,
          request: request(projectRoot),
          activate: false
        })
      ).rejects.toThrow('does not match the runtime identity')
    } finally {
      rmSync(otherProfile, { recursive: true, force: true })
    }
  })
})

function seedRuntime(
  userDataPath: string,
  root: string,
  overrides: { workspaceId?: string; repoId?: string } = {}
): void {
  upsertEphemeralVmRuntime(userDataPath, {
    id: 'runtime-1',
    repoId: overrides.repoId ?? 'repo-1',
    recipeId: 'sandbox',
    recipe: {
      id: 'sandbox',
      name: 'Sandbox',
      create: 'sandbox create',
      checkoutMode: 'provisioned-root'
    },
    connectionMode: 'ssh',
    sshTargetId: connectionId,
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1,
    updatedAt: 1,
    ...(overrides.workspaceId ? { workspaceId: overrides.workspaceId } : {}),
    recipeResult: {
      schemaVersion: 2,
      checkoutMode: 'provisioned-root',
      connection: {
        type: 'ssh',
        target: {
          label: 'Sandbox',
          host: '127.0.0.1',
          port: 22,
          username: 'orca',
          hostKey: { type: 'sha256', fingerprint: `SHA256:${'A'.repeat(43)}` }
        },
        projectRoot: root
      }
    }
  })
}

function worktreeMeta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function repo(path: string): Repo {
  return {
    id: 'repo-1',
    path,
    displayName: 'orca',
    badgeColor: '#000000',
    addedAt: 1,
    connectionId,
    executionHostId: `ssh:${connectionId}`
  }
}

function request(expectedPath: string): AdoptProvisionedRootArgs {
  return {
    repoId: 'repo-1',
    name: 'fix-sandbox',
    runtimeId: 'runtime-1',
    sourceRepoId: 'repo-1',
    executionHostId: `ssh:${connectionId}`,
    expectedPath,
    linkedGitLabIssue: 17
  }
}

function gitWorktree(path: string, overrides: Partial<GitWorktreeInfo> = {}): GitWorktreeInfo {
  return {
    path,
    head: 'abc123',
    branch: 'refs/heads/fix-sandbox',
    isBare: false,
    isMainWorktree: true,
    ...overrides
  }
}

function sparseCheckoutProbe(enabled: boolean): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({ stdout: `${enabled}\n`, stderr: '' })
}

function makeStore(options?: {
  repos?: Repo[]
  sourceRepoIds?: string[]
  initialMeta?: Record<string, WorktreeMeta>
}): {
  store: Store
  setWorktreeMeta: ReturnType<typeof vi.fn>
} {
  const repos = options?.repos ?? [repo(projectRoot)]
  const ownedRepo = repos[0]!
  const meta = new Map(Object.entries(options?.initialMeta ?? {}))
  const setWorktreeMeta = vi.fn((id: string, updates: Partial<WorktreeMeta>) => {
    const next = {
      ...worktreeMeta(),
      ...meta.get(id),
      ...updates
    } as WorktreeMeta
    meta.set(id, next)
    return next
  })
  return {
    store: {
      getRepos: () => repos,
      getProjects: () => [
        {
          id: 'project-1',
          displayName: 'orca',
          badgeColor: '#000000',
          sourceRepoIds: options?.sourceRepoIds ?? ['repo-1'],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      getProjectHostSetups: () => [
        {
          id: 'setup-1',
          projectId: 'project-1',
          hostId: `ssh:${connectionId}`,
          repoId: ownedRepo.id,
          path: ownedRepo.path,
          displayName: ownedRepo.displayName,
          connectionId,
          setupState: 'ready',
          setupMethod: 'imported-existing-folder',
          createdAt: 1,
          updatedAt: 1
        }
      ],
      getWorktreeMeta: (id: string) => meta.get(id),
      getSettings: () => ({ nestWorkspaces: false, workspaceDir: '.orca/worktrees' }),
      setWorktreeMeta
    } as unknown as Store,
    setWorktreeMeta
  }
}
