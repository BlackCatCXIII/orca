import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as SecureFileFilesystem from './secure-file-filesystem'

const openedPaths = vi.hoisted(
  () => [] as { path: string; flags: string | number; ownerWritable: boolean }[]
)
const directoryFsyncFailure = vi.hoisted(() => ({ code: null as string | null }))

vi.mock('./secure-file-filesystem', async () => {
  const actual = await vi.importActual<typeof SecureFileFilesystem>('./secure-file-filesystem')
  const nodeFs = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    fsyncSecurePathSync(path: string, flags: 'r' | 'r+'): void {
      if (nodeFs.statSync(path).isDirectory() && directoryFsyncFailure.code) {
        throw Object.assign(new Error('directory fsync unsupported'), {
          code: directoryFsyncFailure.code
        })
      }
      openedPaths.push({
        path,
        flags,
        ownerWritable: Boolean(nodeFs.statSync(path).mode & 0o200)
      })
      actual.fsyncSecurePathSync(path, flags)
    }
  }
})

import {
  bestEffortFsyncDirectorySync,
  fsyncDirectorySync,
  fsyncFileSync,
  writeDurableSecureJsonFile
} from './secure-file'

const createdPaths: string[] = []

afterEach(() => {
  openedPaths.length = 0
  directoryFsyncFailure.code = null
  for (const path of createdPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('secure file fsync flags', () => {
  const windowsIt = process.platform === 'win32' ? it : it.skip
  windowsIt('opens files read/write before fsync on Windows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-file-fsync-'))
    createdPaths.push(directory)
    const path = join(directory, 'record.json')
    writeFileSync(path, '{}')

    fsyncFileSync(path)

    expect(openedPaths).toMatchObject([{ path, flags: 'r+' }])
  })

  const posixIt = process.platform === 'win32' ? it.skip : it
  posixIt('fsyncs files without owner-write permission', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-file-fsync-read-only-'))
    createdPaths.push(directory)
    const path = join(directory, 'record.json')
    writeFileSync(path, '{}')
    chmodSync(path, 0o400)

    expect(() => fsyncFileSync(path)).not.toThrow()
    expect(openedPaths).toEqual([{ path, flags: 'r', ownerWritable: false }])
  })

  posixIt('durably writes when umask removes owner-write from the temporary file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-durable-file-fsync-read-only-'))
    createdPaths.push(directory)
    const path = join(directory, 'record.json')
    const originalUmask = process.umask(0o200)

    try {
      expect(() => writeDurableSecureJsonFile(path, { ok: true })).not.toThrow()
    } finally {
      process.umask(originalUmask)
    }

    expect(openedPaths[0]).toMatchObject({ flags: 'r', ownerWritable: false })
  })

  posixIt('opens directories read-only before fsync', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-directory-fsync-'))
    createdPaths.push(directory)

    bestEffortFsyncDirectorySync(directory)

    expect(openedPaths).toMatchObject([{ path: directory, flags: 'r' }])
  })

  posixIt.each(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'])(
    'keeps %s directory fsync unsupported in best-effort mode',
    (code) => {
      const directory = mkdtempSync(join(tmpdir(), 'orca-directory-fsync-unsupported-'))
      createdPaths.push(directory)
      directoryFsyncFailure.code = code

      expect(() => bestEffortFsyncDirectorySync(directory)).not.toThrow()
      expect(() => fsyncDirectorySync(directory)).toThrow(expect.objectContaining({ code }))
    }
  )
})
