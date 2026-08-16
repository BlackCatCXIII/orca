import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { upsertEphemeralVmRuntime } from '../../shared/ephemeral-vm-runtime-store'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'

const handlers = new Map<string, (_event: unknown, args: never) => unknown>()
const { getPathMock, handleMock } = vi.hoisted(() => ({
  getPathMock: vi.fn(),
  handleMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: getPathMock },
  ipcMain: { handle: handleMock, removeHandler: vi.fn() }
}))
vi.mock('../ephemeral-vm-runtime-ssh', () => ({
  connectRuntimeOwnedSshTarget: vi.fn(),
  disconnectRuntimeOwnedSshTarget: vi.fn(),
  removeRuntimeOwnedSshTarget: vi.fn()
}))
vi.mock('./runtime-environments', () => ({ invalidateRuntimeEnvironmentTransport: vi.fn() }))

import { registerEphemeralVmRuntimeHandlers } from './ephemeral-vm-runtime-handlers'

const tempDirs: string[] = []

function makeDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

beforeEach(() => {
  handlers.clear()
  handleMock.mockImplementation((method: string, handler: never) => handlers.set(method, handler))
})

describe('operator runtime local IPC isolation', () => {
  it('hides operator runtimes and rejects every local lifecycle entrypoint', async () => {
    const userDataPath = makeDir('orca-operator-ipc-user-data-')
    getPathMock.mockReturnValue(userDataPath)
    upsertEphemeralVmRuntime(userDataPath, {
      id: 'operator-runtime',
      repoId: 'repo-1',
      workspaceId: 'workspace-1',
      recipeId: 'operator-box',
      recipe: { id: 'operator-box', name: 'Operator box', create: '/operator/create' },
      operatorRecipeCatalogSha256: 'a'.repeat(64),
      status: 'suspended',
      cleanupStatus: 'not_started',
      createdAt: 1,
      updatedAt: 1,
      recipeResult: {
        schemaVersion: 1,
        pairingCode: encodePairingOffer({
          v: PAIRING_OFFER_VERSION,
          endpoint: 'wss://operator.invalid',
          deviceToken: 'token',
          publicKeyB64: 'key'
        }),
        projectRoot: '/workspace/repo'
      }
    })
    registerEphemeralVmRuntimeHandlers({ getRepo: vi.fn() } as never)

    expect(handlers.get('ephemeralVm:listRuntimes')?.(null, undefined as never)).toEqual([])
    for (const [method, args] of [
      ['ephemeralVm:attachWorkspace', { runtimeId: 'operator-runtime', workspaceId: 'other' }],
      ['ephemeralVm:cleanup', { runtimeId: 'operator-runtime' }],
      ['ephemeralVm:getCleanupCommand', { runtimeId: 'operator-runtime' }],
      ['ephemeralVm:suspendWorkspace', { workspaceId: 'workspace-1' }],
      ['ephemeralVm:resumeWorkspace', { workspaceId: 'workspace-1' }]
    ] as const) {
      await expect(
        Promise.resolve().then(() => handlers.get(method)?.(null, args as never))
      ).rejects.toThrow(/unavailable/)
    }
  })
})
