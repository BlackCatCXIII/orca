import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SecureFileFilesystem from './secure-file-filesystem'

const filesystemFailure = vi.hoisted(() => ({
  stage: null as 'temp-fsync' | 'rename' | 'parent-dir-fsync' | 'authority-file-fsync' | null,
  swapTargetPath: null as string | null,
  swapReplacementPath: null as string | null,
  rewriteTargetPath: null as string | null,
  rewriteContents: null as string | null
}))

vi.mock('./secure-file-filesystem', async (importOriginal) => {
  const actual = await importOriginal<typeof SecureFileFilesystem>()
  const nodeFs = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    fsyncSecurePathSync(path: string, flags: 'r' | 'r+'): void {
      const stage = nodeFs.statSync(path).isDirectory() ? 'parent-dir-fsync' : 'temp-fsync'
      if (filesystemFailure.stage === stage) {
        throw Object.assign(new Error(`injected ${stage}`), {
          code: stage === 'parent-dir-fsync' ? 'EINVAL' : 'EIO'
        })
      }
      actual.fsyncSecurePathSync(path, flags)
    },
    renameSecureFileSync(sourcePath: string, targetPath: string): void {
      if (filesystemFailure.stage === 'rename') {
        throw Object.assign(new Error('injected rename'), { code: 'EIO' })
      }
      actual.renameSecureFileSync(sourcePath, targetPath)
    },
    fsyncSecureFileDescriptorSync(descriptor: number): void {
      if (filesystemFailure.stage === 'authority-file-fsync') {
        throw Object.assign(new Error('injected authority file fsync'), { code: 'EIO' })
      }
      if (filesystemFailure.swapTargetPath && filesystemFailure.swapReplacementPath) {
        nodeFs.renameSync(filesystemFailure.swapReplacementPath, filesystemFailure.swapTargetPath)
        filesystemFailure.swapTargetPath = null
        filesystemFailure.swapReplacementPath = null
      }
      if (filesystemFailure.rewriteTargetPath && filesystemFailure.rewriteContents) {
        nodeFs.writeFileSync(
          filesystemFailure.rewriteTargetPath,
          filesystemFailure.rewriteContents,
          'utf8'
        )
        filesystemFailure.rewriteTargetPath = null
        filesystemFailure.rewriteContents = null
      }
      actual.fsyncSecureFileDescriptorSync(descriptor)
    }
  }
})
import { encodePairingOffer, PAIRING_OFFER_VERSION } from './pairing'
import {
  EphemeralVmRuntimeStoreError,
  getEphemeralVmRuntimeStorePath,
  listAuthoritativeEphemeralVmRuntimes,
  listEphemeralVmRuntimes,
  MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES,
  removeEphemeralVmRuntime,
  updateEphemeralVmRuntimeStatus,
  upsertEphemeralVmRuntime
} from './ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from './ephemeral-vm-runtimes'

const posixIt = process.platform === 'win32' ? it.skip : it

function pairingCode(endpoint = 'wss://sandbox.example.com'): string {
  return encodePairingOffer({
    v: PAIRING_OFFER_VERSION,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
  })
}

function runtimeRecord(
  overrides: Partial<EphemeralVmRuntimeRecord> = {}
): EphemeralVmRuntimeRecord {
  return {
    id: 'orca-instance-1',
    recipeId: 'cloud-sandbox',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    workspaceName: 'Fix Login Race',
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1_000,
    updatedAt: 1_000,
    recipeResult: {
      schemaVersion: 1,
      pairingCode: pairingCode(),
      projectRoot: '/workspace/repo',
      userData: { providerResourceId: 'sandbox-123' }
    },
    ...overrides
  }
}

function corruptPersistedJsonField(path: string, value: string): void {
  const bytes = readFileSync(path)
  const offset = bytes.indexOf(value)
  if (offset === -1) {
    throw new Error(`Persisted field not found: ${value}`)
  }
  bytes[offset] = 0xc3
  bytes[offset + 1] = 0x28
  writeFileSync(path, bytes)
}

describe('ephemeral VM runtime store', () => {
  const tempDirs: string[] = []
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    // Why: secure-file has dedicated ACL coverage; this suite focuses on store semantics.
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  })

  afterEach(() => {
    filesystemFailure.stage = null
    filesystemFailure.swapTargetPath = null
    filesystemFailure.swapReplacementPath = null
    filesystemFailure.rewriteTargetPath = null
    filesystemFailure.rewriteContents = null
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeUserDataPath(): string {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-ephemeral-vm-store-'))
    tempDirs.push(userDataPath)
    return userDataPath
  }

  it('persists recipe-created runtimes separately from saved remote environments', () => {
    const userDataPath = makeUserDataPath()
    const first = upsertEphemeralVmRuntime(userDataPath, runtimeRecord())
    const second = upsertEphemeralVmRuntime(
      userDataPath,
      runtimeRecord({
        id: 'orca-instance-2',
        createdAt: 2_000,
        updatedAt: 2_000,
        recipeResult: {
          schemaVersion: 1,
          pairingCode: pairingCode('wss://sandbox-2.example.com'),
          projectRoot: '/workspace/repo'
        }
      })
    )

    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([second, first])
  })

  it('updates lifecycle and cleanup state', () => {
    const userDataPath = makeUserDataPath()
    upsertEphemeralVmRuntime(userDataPath, runtimeRecord())

    const failed = updateEphemeralVmRuntimeStatus(userDataPath, 'orca-instance-1', {
      status: 'cleanup_failed',
      cleanupStatus: 'failed',
      cleanupLastAttemptAt: 3_000,
      cleanupLastError: 'provider delete failed',
      updatedAt: 3_000
    })

    expect(failed).toMatchObject({
      status: 'cleanup_failed',
      cleanupStatus: 'failed',
      cleanupLastAttemptAt: 3_000,
      cleanupLastError: 'provider delete failed',
      updatedAt: 3_000
    })

    const recovered = updateEphemeralVmRuntimeStatus(userDataPath, 'orca-instance-1', {
      status: 'cleaned',
      cleanupStatus: 'succeeded',
      cleanupLastError: null,
      updatedAt: 4_000
    })

    expect(recovered).toMatchObject({
      status: 'cleaned',
      cleanupStatus: 'succeeded',
      updatedAt: 4_000
    })
    expect(recovered.cleanupLastError).toBeUndefined()
  })

  it('persists runtime connection metadata', () => {
    const userDataPath = makeUserDataPath()
    upsertEphemeralVmRuntime(
      userDataPath,
      runtimeRecord({
        connectionMode: 'ssh',
        sshTargetId: 'runtime-ssh-orca-instance-1',
        recipeResult: {
          schemaVersion: 1,
          connection: {
            type: 'ssh',
            projectRoot: '/workspace/repo',
            target: {
              label: 'Sandbox',
              host: 'sandbox.example.com',
              port: 22,
              username: 'root'
            }
          }
        }
      })
    )

    expect(listEphemeralVmRuntimes(userDataPath)[0]).toMatchObject({
      connectionMode: 'ssh',
      sshTargetId: 'runtime-ssh-orca-instance-1',
      recipeResult: {
        connection: {
          type: 'ssh',
          projectRoot: '/workspace/repo'
        }
      }
    })
  })

  it('removes cleaned runtimes', () => {
    const userDataPath = makeUserDataPath()
    const record = upsertEphemeralVmRuntime(userDataPath, runtimeRecord())

    expect(removeEphemeralVmRuntime(userDataPath, record.id)).toEqual(record)
    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([])
  })

  it('throws a store error for invalid persisted JSON', () => {
    const userDataPath = makeUserDataPath()
    writeFileSync(getEphemeralVmRuntimeStorePath(userDataPath), '{ nope', 'utf8')

    expect(() => listEphemeralVmRuntimes(userDataPath)).toThrow(EphemeralVmRuntimeStoreError)
  })

  it('rejects malformed UTF-8 in a persisted provision binding', () => {
    const userDataPath = makeUserDataPath()
    const resolvedRef = 'a'.repeat(40)
    upsertEphemeralVmRuntime(
      userDataPath,
      runtimeRecord({
        provisionMutation: { requestSha256: 'f'.repeat(64), resolvedRef }
      })
    )
    corruptPersistedJsonField(getEphemeralVmRuntimeStorePath(userDataPath), resolvedRef)

    expect(() => listEphemeralVmRuntimes(userDataPath)).toThrow(EphemeralVmRuntimeStoreError)
  })

  it('rejects duplicate JSON keys in a persisted provision binding', () => {
    const userDataPath = makeUserDataPath()
    const resolvedRef = 'a'.repeat(40)
    upsertEphemeralVmRuntime(
      userDataPath,
      runtimeRecord({
        provisionMutation: { requestSha256: 'f'.repeat(64), resolvedRef }
      })
    )
    const path = getEphemeralVmRuntimeStorePath(userDataPath)
    const source = readFileSync(path, 'utf8').replace(
      `"resolvedRef":"${resolvedRef}"`,
      `"resolvedRef":"${resolvedRef}","resolvedRef":"${resolvedRef}"`
    )
    writeFileSync(path, source, 'utf8')

    expect(() => listEphemeralVmRuntimes(userDataPath)).toThrow(EphemeralVmRuntimeStoreError)
  })

  it('rejects duplicate persisted runtime IDs', () => {
    const userDataPath = makeUserDataPath()
    const runtime = runtimeRecord()
    writeFileSync(
      getEphemeralVmRuntimeStorePath(userDataPath),
      JSON.stringify({
        version: 1,
        runtimes: [runtime, { ...runtime, workspaceName: 'Conflicting duplicate' }]
      }),
      'utf8'
    )

    expect(() => listEphemeralVmRuntimes(userDataPath)).toThrow(EphemeralVmRuntimeStoreError)
  })

  it('rejects an oversized sparse runtime store before parsing it', () => {
    const userDataPath = makeUserDataPath()
    const path = getEphemeralVmRuntimeStorePath(userDataPath)
    writeFileSync(path, '{"version":1,"runtimes":[]}', 'utf8')
    truncateSync(path, MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES + 1)

    expect(() => listEphemeralVmRuntimes(userDataPath)).toThrow(EphemeralVmRuntimeStoreError)
  })

  it('rejects an oversized write without publishing a partial runtime record', () => {
    const userDataPath = makeUserDataPath()

    expect(() =>
      upsertEphemeralVmRuntime(
        userDataPath,
        runtimeRecord({
          cleanupLastError: 'x'.repeat(MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES)
        })
      )
    ).toThrow(EphemeralVmRuntimeStoreError)
    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([])
  })

  it('keeps local-only runtime stores on best-effort durability', () => {
    const userDataPath = makeUserDataPath()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    expect(() => upsertEphemeralVmRuntime(userDataPath, runtimeRecord())).not.toThrow()
    expect(listEphemeralVmRuntimes(userDataPath)).toHaveLength(1)
    filesystemFailure.stage = 'authority-file-fsync'
    expect(listAuthoritativeEphemeralVmRuntimes(userDataPath)).toHaveLength(1)
  })

  it('requires critical durability to publish or remove operator runtimes', () => {
    const userDataPath = makeUserDataPath()
    const operatorRuntime = runtimeRecord({
      operatorRecipeCatalogSha256: 'c'.repeat(64),
      provisionMutation: { requestSha256: 'f'.repeat(64), resolvedRef: 'a'.repeat(40) }
    })
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    expect(() => upsertEphemeralVmRuntime(userDataPath, operatorRuntime)).toThrow(
      'Critical secure-file durability is unavailable on Windows.'
    )
    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([])

    writeFileSync(
      getEphemeralVmRuntimeStorePath(userDataPath),
      JSON.stringify({ version: 1, runtimes: [operatorRuntime] })
    )
    expect(() =>
      upsertEphemeralVmRuntime(userDataPath, runtimeRecord({ id: 'local-runtime' }))
    ).toThrow('Critical secure-file durability is unavailable on Windows.')
    expect(() => removeEphemeralVmRuntime(userDataPath, operatorRuntime.id)).toThrow(
      'Critical secure-file durability is unavailable on Windows.'
    )
    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([operatorRuntime])
    expect(() => listAuthoritativeEphemeralVmRuntimes(userDataPath)).toThrow(
      EphemeralVmRuntimeStoreError
    )
  })

  posixIt('propagates unsupported operator parent-directory durability', () => {
    const userDataPath = makeUserDataPath()
    filesystemFailure.stage = 'parent-dir-fsync'

    expect(() =>
      upsertEphemeralVmRuntime(
        userDataPath,
        runtimeRecord({ operatorRecipeCatalogSha256: 'c'.repeat(64) })
      )
    ).toThrow(expect.objectContaining({ code: 'EINVAL' }))
  })

  posixIt.each(['running', 'cleaned', 'cleanup_failed'] as const)(
    'requires successful file and parent re-durabilization before %s operator authority',
    (status) => {
      const userDataPath = makeUserDataPath()
      const operatorRuntime = runtimeRecord({
        operatorRecipeCatalogSha256: 'c'.repeat(64),
        provisionMutation: { requestSha256: 'f'.repeat(64), resolvedRef: 'a'.repeat(40) },
        status,
        cleanupStatus:
          status === 'cleaned'
            ? 'succeeded'
            : status === 'cleanup_failed'
              ? 'failed'
              : 'not_started'
      })
      filesystemFailure.stage = 'parent-dir-fsync'
      expect(() => upsertEphemeralVmRuntime(userDataPath, operatorRuntime)).toThrow()
      expect(listEphemeralVmRuntimes(userDataPath)).toEqual([operatorRuntime])
      expect(() => listAuthoritativeEphemeralVmRuntimes(userDataPath)).toThrow(
        EphemeralVmRuntimeStoreError
      )

      filesystemFailure.stage = 'authority-file-fsync'
      expect(() => listAuthoritativeEphemeralVmRuntimes(userDataPath)).toThrow(
        EphemeralVmRuntimeStoreError
      )

      filesystemFailure.stage = null
      expect(listAuthoritativeEphemeralVmRuntimes(userDataPath)).toEqual([operatorRuntime])
    }
  )

  posixIt('rejects a path swap between operator observation and descriptor fsync', () => {
    const userDataPath = makeUserDataPath()
    const operatorRuntime = runtimeRecord({
      operatorRecipeCatalogSha256: 'c'.repeat(64),
      provisionMutation: { requestSha256: 'f'.repeat(64), resolvedRef: 'a'.repeat(40) }
    })
    upsertEphemeralVmRuntime(userDataPath, operatorRuntime)
    const targetPath = getEphemeralVmRuntimeStorePath(userDataPath)
    const replacementPath = join(userDataPath, 'replacement-runtime-store.json')
    const replacementRuntime = runtimeRecord({ id: 'replacement-runtime' })
    writeFileSync(
      replacementPath,
      JSON.stringify({ version: 1, runtimes: [replacementRuntime] }),
      'utf8'
    )
    filesystemFailure.swapTargetPath = targetPath
    filesystemFailure.swapReplacementPath = replacementPath

    expect(() => listAuthoritativeEphemeralVmRuntimes(userDataPath)).toThrow(
      EphemeralVmRuntimeStoreError
    )
    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([replacementRuntime])
  })

  posixIt('rejects same-inode byte changes while establishing operator authority', () => {
    const userDataPath = makeUserDataPath()
    const operatorRuntime = runtimeRecord({
      operatorRecipeCatalogSha256: 'c'.repeat(64),
      provisionMutation: { requestSha256: 'f'.repeat(64), resolvedRef: 'a'.repeat(40) }
    })
    upsertEphemeralVmRuntime(userDataPath, operatorRuntime)
    const targetPath = getEphemeralVmRuntimeStorePath(userDataPath)
    const replacementRuntime = runtimeRecord({
      id: 'rewritten-runtime',
      operatorRecipeCatalogSha256: 'c'.repeat(64),
      provisionMutation: { requestSha256: 'e'.repeat(64), resolvedRef: 'b'.repeat(40) }
    })
    filesystemFailure.rewriteTargetPath = targetPath
    filesystemFailure.rewriteContents = JSON.stringify({
      version: 1,
      runtimes: [replacementRuntime]
    })

    expect(() => listAuthoritativeEphemeralVmRuntimes(userDataPath)).toThrow(
      EphemeralVmRuntimeStoreError
    )
    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([replacementRuntime])
  })

  it.each([
    ['catalog removal', { operatorRecipeCatalogSha256: undefined }],
    ['catalog drift', { operatorRecipeCatalogSha256: 'd'.repeat(64) }],
    ['provision binding removal', { provisionMutation: undefined }],
    [
      'request binding drift',
      { provisionMutation: { requestSha256: 'e'.repeat(64), resolvedRef: 'a'.repeat(40) } }
    ],
    [
      'resolved ref drift',
      { provisionMutation: { requestSha256: 'f'.repeat(64), resolvedRef: 'b'.repeat(40) } }
    ]
  ])('rejects same-ID operator %s', (_name, bindingOverride) => {
    const userDataPath = makeUserDataPath()
    const operatorRuntime = runtimeRecord({
      operatorRecipeCatalogSha256: 'c'.repeat(64),
      provisionMutation: { requestSha256: 'f'.repeat(64), resolvedRef: 'a'.repeat(40) }
    })
    upsertEphemeralVmRuntime(userDataPath, operatorRuntime)

    expect(() =>
      upsertEphemeralVmRuntime(userDataPath, {
        ...operatorRuntime,
        ...bindingOverride,
        status: 'suspended',
        updatedAt: 2_000
      })
    ).toThrow(expect.objectContaining({ code: 'invalid_argument' }))
    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([operatorRuntime])
  })

  it('allows identical operator binding replay and ordinary nonoperator replacement', () => {
    const userDataPath = makeUserDataPath()
    const operatorRuntime = runtimeRecord({
      operatorRecipeCatalogSha256: 'c'.repeat(64),
      provisionMutation: { requestSha256: 'f'.repeat(64), resolvedRef: 'a'.repeat(40) }
    })
    upsertEphemeralVmRuntime(userDataPath, operatorRuntime)
    const updatedOperator = { ...operatorRuntime, status: 'suspended' as const, updatedAt: 2_000 }
    expect(upsertEphemeralVmRuntime(userDataPath, updatedOperator)).toEqual(updatedOperator)

    const localPath = makeUserDataPath()
    upsertEphemeralVmRuntime(localPath, runtimeRecord())
    const replacedLocal = runtimeRecord({ status: 'suspended', updatedAt: 2_000 })
    expect(upsertEphemeralVmRuntime(localPath, replacedLocal)).toEqual(replacedLocal)
  })
})
