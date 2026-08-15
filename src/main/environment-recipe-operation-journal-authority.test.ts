import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type * as NodePath from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SecureFileFilesystem from '../shared/secure-file-filesystem'

const authorityFault = vi.hoisted(() => ({
  fileFsyncPath: null as string | null,
  parentFsyncPath: null as string | null,
  replacementPath: null as string | null,
  swapTargetPath: null as string | null,
  swapParentPath: null as string | null,
  swapParentMovedPath: null as string | null
}))

vi.mock('../shared/secure-file-filesystem', async (importOriginal) => {
  const actual = await importOriginal<typeof SecureFileFilesystem>()
  const nodeFs = await vi.importActual<typeof NodeFs>('node:fs')
  const nodePath = await vi.importActual<typeof NodePath>('node:path')
  const descriptorMatches = (descriptor: number, path: string): boolean => {
    try {
      const descriptorStats = nodeFs.fstatSync(descriptor, { bigint: true })
      const pathStats = nodeFs.lstatSync(path, { bigint: true })
      return descriptorStats.dev === pathStats.dev && descriptorStats.ino === pathStats.ino
    } catch {
      return false
    }
  }
  return {
    ...actual,
    fsyncSecureFileDescriptorSync(descriptor: number): void {
      if (
        authorityFault.fileFsyncPath &&
        descriptorMatches(descriptor, authorityFault.fileFsyncPath)
      ) {
        throw Object.assign(new Error('injected journal authority file fsync'), { code: 'EIO' })
      }
      if (
        authorityFault.swapTargetPath &&
        authorityFault.replacementPath &&
        descriptorMatches(descriptor, authorityFault.swapTargetPath)
      ) {
        nodeFs.renameSync(authorityFault.replacementPath, authorityFault.swapTargetPath)
        authorityFault.swapTargetPath = null
        authorityFault.replacementPath = null
      }
      actual.fsyncSecureFileDescriptorSync(descriptor)
    },
    fsyncSecureDirectoryDescriptorSync(descriptor: number): void {
      const parentPath = authorityFault.parentFsyncPath
        ? dirname(authorityFault.parentFsyncPath)
        : null
      if (parentPath && descriptorMatches(descriptor, parentPath)) {
        throw Object.assign(new Error('injected journal authority parent fsync'), {
          code: 'EINVAL'
        })
      }
      if (
        authorityFault.swapParentPath &&
        authorityFault.swapParentMovedPath &&
        authorityFault.swapTargetPath &&
        descriptorMatches(descriptor, authorityFault.swapParentPath)
      ) {
        const journalName = basename(authorityFault.swapTargetPath)
        nodeFs.renameSync(authorityFault.swapParentPath, authorityFault.swapParentMovedPath)
        nodeFs.mkdirSync(authorityFault.swapParentPath)
        nodeFs.linkSync(
          nodePath.join(authorityFault.swapParentMovedPath, journalName),
          nodePath.join(authorityFault.swapParentPath, journalName)
        )
        authorityFault.swapParentPath = null
        authorityFault.swapParentMovedPath = null
        authorityFault.swapTargetPath = null
      }
      actual.fsyncSecureDirectoryDescriptorSync(descriptor)
    }
  }
})

import type { EnvironmentRecipeRuntime } from '../shared/environment-recipe-runtime-rpc'
import {
  environmentRecipeMutationRequestSha256,
  resetEnvironmentRecipeOperationControlForTests,
  runIdempotentEnvironmentRecipeMutation
} from './environment-recipe-operation-control'
import {
  getEnvironmentRecipeOperationJournalPath,
  prepareDurableEnvironmentRecipeMutation,
  readDurableEnvironmentRecipeMutation
} from './environment-recipe-operation-journal'

const operatorRecipeCatalogSha256 = 'c'.repeat(64)
const provisionRef = 'a'.repeat(40)
const roots: string[] = []
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const posixIt = process.platform === 'win32' ? it.skip : it

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-operation-journal-authority-'))
  roots.push(root)
  return root
}

function mutation(clientMutationId = 'journal-authority') {
  const params = { clientMutationId }
  return {
    params,
    identity: {
      pairedDeviceId: 'paired-device',
      method: 'environmentRecipes.provision',
      clientMutationId
    }
  }
}

function prepareJournal(userDataPath: string, clientMutationId = 'journal-authority'): void {
  const { identity, params } = mutation(clientMutationId)
  prepareDurableEnvironmentRecipeMutation(userDataPath, {
    ...identity,
    fingerprint: environmentRecipeMutationRequestSha256(params),
    provisionRef,
    runtimeId: `${clientMutationId}-runtime`,
    operatorRecipeCatalogSha256
  })
}

function unusedRuntime(): EnvironmentRecipeRuntime {
  return {
    runtimeId: 'unexpected-runtime',
    repoId: 'repo-1',
    recipeId: 'operator-box',
    checkoutMode: 'provisioned-root',
    status: 'running',
    lifecycle: { suspend: false, resume: false, destroy: true },
    createdAt: 1,
    updatedAt: 1,
    connectionType: 'ssh',
    projectRoot: '/srv/repo'
  }
}

async function expectReplayAuthorityFailure(
  userDataPath: string,
  clientMutationId = 'journal-authority'
): Promise<void> {
  const { identity, params } = mutation(clientMutationId)
  const operation = vi.fn(async () => unusedRuntime())
  await expect(
    runIdempotentEnvironmentRecipeMutation(
      userDataPath,
      identity.pairedDeviceId,
      identity.method,
      params,
      operation,
      { operatorRecipeCatalogSha256 }
    )
  ).rejects.toMatchObject({ code: 'environment_recipe_failed' })
  expect(operation).not.toHaveBeenCalled()
}

describe('environment recipe operation journal authority', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  })

  afterEach(() => {
    resetEnvironmentRecipeOperationControlForTests()
    authorityFault.fileFsyncPath = null
    authorityFault.parentFsyncPath = null
    authorityFault.replacementPath = null
    authorityFault.swapTargetPath = null
    authorityFault.swapParentPath = null
    authorityFault.swapParentMovedPath = null
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps a genuinely missing journal empty before its first critical write', () => {
    const userDataPath = makeRoot()
    const { identity } = mutation()

    expect(readDurableEnvironmentRecipeMutation(userDataPath, identity)).toBeNull()
    prepareJournal(userDataPath)
    expect(readDurableEnvironmentRecipeMutation(userDataPath, identity)).toMatchObject(identity)
  })

  posixIt('reads an existing journal through a profile-directory alias', () => {
    const outerPath = makeRoot()
    const userDataPath = join(outerPath, 'profile')
    const aliasPath = join(outerPath, 'profile-alias')
    mkdirSync(userDataPath)
    prepareJournal(userDataPath)
    symlinkSync(userDataPath, aliasPath, 'dir')

    const { identity } = mutation()
    expect(readDurableEnvironmentRecipeMutation(aliasPath, identity)).toMatchObject(identity)
  })

  posixIt('rejects a dangling profile-directory alias before replay', async () => {
    const outerPath = makeRoot()
    const aliasPath = join(outerPath, 'profile-alias')
    symlinkSync(join(outerPath, 'missing-profile'), aliasPath, 'dir')

    await expectReplayAuthorityFailure(aliasPath)
  })

  it('rejects an existing journal before replay on simulated Windows', async () => {
    const userDataPath = makeRoot()
    prepareJournal(userDataPath)
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    await expectReplayAuthorityFailure(userDataPath)
  })

  posixIt.each(['file', 'parent'] as const)(
    'rejects an existing journal when authority %s fsync fails',
    async (stage) => {
      const userDataPath = makeRoot()
      prepareJournal(userDataPath)
      const journalPath = getEnvironmentRecipeOperationJournalPath(userDataPath)
      if (stage === 'file') {
        authorityFault.fileFsyncPath = journalPath
      } else {
        authorityFault.parentFsyncPath = journalPath
      }

      await expectReplayAuthorityFailure(userDataPath)
    }
  )

  posixIt.each(['valid', 'dangling'] as const)(
    'rejects a %s final journal symlink before replay',
    async (mode) => {
      const userDataPath = makeRoot()
      prepareJournal(userDataPath)
      const journalPath = getEnvironmentRecipeOperationJournalPath(userDataPath)
      const backingPath = join(userDataPath, 'journal-backing.json')
      renameSync(journalPath, backingPath)
      symlinkSync(
        mode === 'valid' ? basename(backingPath) : 'missing-journal-backing.json',
        journalPath
      )

      await expectReplayAuthorityFailure(userDataPath)
    }
  )

  posixIt('rejects a non-regular final journal before replay', async () => {
    const userDataPath = makeRoot()
    prepareJournal(userDataPath)
    const journalPath = getEnvironmentRecipeOperationJournalPath(userDataPath)
    rmSync(journalPath)
    mkdirSync(journalPath)

    await expectReplayAuthorityFailure(userDataPath)
  })

  posixIt('rejects deterministic final journal replacement before replay', async () => {
    const userDataPath = makeRoot()
    prepareJournal(userDataPath)
    const journalPath = getEnvironmentRecipeOperationJournalPath(userDataPath)
    const replacementPath = join(userDataPath, 'replacement-journal.json')
    writeFileSync(replacementPath, JSON.stringify({ version: 1, entries: [] }), 'utf8')
    authorityFault.swapTargetPath = journalPath
    authorityFault.replacementPath = replacementPath

    await expectReplayAuthorityFailure(userDataPath)
  })

  posixIt('rejects deterministic journal parent replacement before replay', async () => {
    const outerPath = makeRoot()
    const userDataPath = join(outerPath, 'profile')
    mkdirSync(userDataPath)
    prepareJournal(userDataPath)
    authorityFault.swapTargetPath = getEnvironmentRecipeOperationJournalPath(userDataPath)
    authorityFault.swapParentPath = userDataPath
    authorityFault.swapParentMovedPath = join(outerPath, 'profile-observed')

    await expectReplayAuthorityFailure(userDataPath)
  })

  it('rejects a non-directory journal parent instead of treating it as missing', async () => {
    const outerPath = makeRoot()
    const nonDirectory = join(outerPath, 'not-a-directory')
    writeFileSync(nonDirectory, 'blocked', 'utf8')

    await expectReplayAuthorityFailure(join(nonDirectory, 'profile'))
  })
})
