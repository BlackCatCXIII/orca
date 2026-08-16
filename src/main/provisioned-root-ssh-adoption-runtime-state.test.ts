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
  updateEphemeralVmRuntimeStatus,
  upsertEphemeralVmRuntime
} from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeStatus } from '../shared/ephemeral-vm-runtimes'
import { registerSshGitProvider, unregisterSshGitProvider } from './providers/ssh-git-dispatch'
import { resetSshProviderAuthorities } from './ssh/ssh-provider-authority'
import { OrcaRuntimeService } from './runtime/orca-runtime'

const connectionId = 'runtime-ssh-state-test'
const projectRoot = '/workspace/orca'
const worktreeId = `repo-1::${projectRoot}`
const rejectedStatuses = [
  'provisioning',
  'suspended',
  'suspend_failed',
  'resume_failed',
  'failed',
  'cleanup_pending',
  'cleanup_failed',
  'cleaned'
] as const satisfies readonly EphemeralVmRuntimeStatus[]

describe('provisioned-root adoption runtime state authority', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-provisioned-root-state-'))
    resetSshProviderAuthorities()
  })

  afterEach(() => {
    unregisterSshGitProvider(connectionId)
    resetSshProviderAuthorities()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it.each(rejectedStatuses)(
    'rejects %s before remote verification without side effects',
    async (status) => {
      seedRuntime(userDataPath, { status })
      const listWorktrees = vi.fn().mockResolvedValue([gitWorktree()])
      const exec = sparseCheckoutProbe()
      registerSshGitProvider(connectionId, { listWorktrees, exec } as never)
      const { store, setWorktreeMeta } = makeStore()
      const runtime = new OrcaRuntimeService(store)
      const effects = observeAdoptionEffects(runtime)
      const before = listEphemeralVmRuntimes(userDataPath)

      await expect(adopt(runtime, userDataPath)).rejects.toThrow(
        'does not own this provisioned SSH checkout'
      )

      expect(listWorktrees).not.toHaveBeenCalled()
      expect(exec).not.toHaveBeenCalled()
      expect(setWorktreeMeta).not.toHaveBeenCalled()
      expect(listEphemeralVmRuntimes(userDataPath)).toEqual(before)
      expect(effects.invalidation).not.toHaveBeenCalled()
      expect(effects.lifecycle).toEqual([])
      expect(effects.clientEvents).toEqual([])
    }
  )

  it.each(rejectedStatuses)(
    'rejects a running runtime that changes to %s during remote verification without side effects',
    async (status) => {
      seedRuntime(userDataPath)
      let resolveWorktrees: (worktrees: GitWorktreeInfo[]) => void = () => undefined
      const listWorktrees = vi.fn(
        () =>
          new Promise<GitWorktreeInfo[]>((resolve) => {
            resolveWorktrees = resolve
          })
      )
      registerSshGitProvider(connectionId, {
        listWorktrees,
        exec: sparseCheckoutProbe()
      } as never)
      const { store, setWorktreeMeta } = makeStore()
      const runtime = new OrcaRuntimeService(store)
      const effects = observeAdoptionEffects(runtime)

      const pending = adopt(runtime, userDataPath)
      await vi.waitFor(() => expect(listWorktrees).toHaveBeenCalledOnce())
      updateEphemeralVmRuntimeStatus(userDataPath, 'runtime-1', { status })
      const afterStatusChange = listEphemeralVmRuntimes(userDataPath)
      resolveWorktrees([gitWorktree()])

      await expect(pending).rejects.toThrow('does not own this provisioned SSH checkout')
      expect(setWorktreeMeta).not.toHaveBeenCalled()
      expect(listEphemeralVmRuntimes(userDataPath)).toEqual(afterStatusChange)
      expect(afterStatusChange[0]?.workspaceId).toBeUndefined()
      expect(effects.invalidation).not.toHaveBeenCalled()
      expect(effects.lifecycle).toEqual([])
      expect(effects.clientEvents).toEqual([])
    }
  )

  it.each([
    ['provisioning', true],
    ['running', true],
    ['suspended', true],
    ['suspend_failed', true],
    ['resume_failed', true],
    ['failed', true],
    ['cleanup_pending', true],
    ['cleanup_failed', true],
    ['cleaned', false]
  ] as const satisfies readonly (readonly [EphemeralVmRuntimeStatus, boolean])[])(
    'treats another %s runtime with the same workspace as conflict=%s',
    async (status, conflicts) => {
      seedRuntime(userDataPath)
      seedRuntime(userDataPath, { id: 'runtime-2', status, workspaceId: worktreeId })
      registerSshGitProvider(connectionId, {
        listWorktrees: vi.fn().mockResolvedValue([gitWorktree()]),
        exec: sparseCheckoutProbe()
      } as never)
      const { store, setWorktreeMeta } = makeStore()
      const runtime = new OrcaRuntimeService(store)
      const effects = observeAdoptionEffects(runtime)
      const before = listEphemeralVmRuntimes(userDataPath)

      if (conflicts) {
        await expect(adopt(runtime, userDataPath)).rejects.toThrow(
          'already attached to another runtime'
        )
        expect(setWorktreeMeta).not.toHaveBeenCalled()
        expect(listEphemeralVmRuntimes(userDataPath)).toEqual(before)
        expect(effects.invalidation).not.toHaveBeenCalled()
        expect(effects.lifecycle).toEqual([])
        expect(effects.clientEvents).toEqual([])
        return
      }

      await expect(adopt(runtime, userDataPath)).resolves.toMatchObject({
        worktree: { id: worktreeId }
      })
      expect(setWorktreeMeta).toHaveBeenCalledOnce()
      expect(
        listEphemeralVmRuntimes(userDataPath).find((entry) => entry.id === 'runtime-2')
      ).toMatchObject({
        status: 'cleaned',
        workspaceId: worktreeId
      })
    }
  )
})

function adopt(runtime: OrcaRuntimeService, userDataPath: string) {
  return runtime.adoptManagedProvisionedRoot({
    repoId: 'repo-1',
    userDataPath,
    request: request(),
    activate: true
  })
}

function observeAdoptionEffects(runtime: OrcaRuntimeService): {
  invalidation: ReturnType<typeof vi.fn>
  lifecycle: unknown[]
  clientEvents: unknown[]
} {
  const invalidation = vi.fn()
  ;(
    runtime as unknown as { invalidateResolvedWorktreeCache: ReturnType<typeof vi.fn> }
  ).invalidateResolvedWorktreeCache = invalidation
  const lifecycle: unknown[] = []
  const clientEvents: unknown[] = []
  runtime.onWorktreeLifecycle((event) => lifecycle.push(event))
  runtime.onClientEvent((event) => clientEvents.push(event))
  return { invalidation, lifecycle, clientEvents }
}

function seedRuntime(
  userDataPath: string,
  overrides: {
    id?: string
    status?: EphemeralVmRuntimeStatus
    workspaceId?: string
  } = {}
): void {
  upsertEphemeralVmRuntime(userDataPath, {
    id: overrides.id ?? 'runtime-1',
    repoId: 'repo-1',
    recipeId: 'sandbox',
    recipe: {
      id: 'sandbox',
      name: 'Sandbox',
      create: 'sandbox create',
      checkoutMode: 'provisioned-root'
    },
    connectionMode: 'ssh',
    sshTargetId: connectionId,
    status: overrides.status ?? 'running',
    cleanupStatus:
      overrides.status === 'cleaned'
        ? 'succeeded'
        : overrides.status === 'cleanup_pending'
          ? 'running'
          : overrides.status === 'cleanup_failed'
            ? 'failed'
            : 'not_started',
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
        projectRoot
      }
    }
  })
}

function request(): AdoptProvisionedRootArgs {
  return {
    repoId: 'repo-1',
    name: 'fix-sandbox',
    runtimeId: 'runtime-1',
    sourceRepoId: 'repo-1',
    executionHostId: `ssh:${connectionId}`,
    expectedPath: projectRoot
  }
}

function gitWorktree(): GitWorktreeInfo {
  return {
    path: projectRoot,
    head: 'abc123',
    branch: 'refs/heads/fix-sandbox',
    isBare: false,
    isMainWorktree: true
  }
}

function sparseCheckoutProbe(): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({ stdout: 'false\n', stderr: '' })
}

function makeStore(): {
  store: Store
  setWorktreeMeta: ReturnType<typeof vi.fn>
} {
  const ownedRepo = repo()
  const meta = new Map<string, WorktreeMeta>()
  const setWorktreeMeta = vi.fn((id: string, updates: Partial<WorktreeMeta>) => {
    const next = { ...worktreeMeta(), ...updates } as WorktreeMeta
    meta.set(id, next)
    return next
  })
  return {
    store: {
      getRepos: () => [ownedRepo],
      getProjects: () => [
        {
          id: 'project-1',
          displayName: 'orca',
          badgeColor: '#000000',
          sourceRepoIds: ['repo-1'],
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

function repo(): Repo {
  return {
    id: 'repo-1',
    path: projectRoot,
    displayName: 'orca',
    badgeColor: '#000000',
    addedAt: 1,
    connectionId,
    executionHostId: `ssh:${connectionId}`
  }
}

function worktreeMeta(): WorktreeMeta {
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
    lastActivityAt: 0
  }
}
