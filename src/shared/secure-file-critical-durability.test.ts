import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as SecureFileFilesystem from './secure-file-filesystem'

type CriticalSecureFileStage = 'temp-fsync' | 'rename' | 'parent-dir-fsync'

const filesystemState = vi.hoisted(() => ({
  failedStage: null as CriticalSecureFileStage | null,
  stages: [] as CriticalSecureFileStage[]
}))

vi.mock('./secure-file-filesystem', async (importOriginal) => {
  const actual = await importOriginal<typeof SecureFileFilesystem>()
  const nodeFs = await vi.importActual<typeof NodeFs>('node:fs')
  const visit = (stage: CriticalSecureFileStage): void => {
    filesystemState.stages.push(stage)
    if (filesystemState.failedStage === stage) {
      throw Object.assign(new Error(`injected ${stage}`), {
        code: stage === 'parent-dir-fsync' ? 'ENOTSUP' : 'EIO'
      })
    }
  }
  return {
    ...actual,
    fsyncSecurePathSync(path: string, flags: 'r' | 'r+'): void {
      visit(nodeFs.statSync(path).isDirectory() ? 'parent-dir-fsync' : 'temp-fsync')
      actual.fsyncSecurePathSync(path, flags)
    },
    renameSecureFileSync(sourcePath: string, targetPath: string): void {
      visit('rename')
      actual.renameSecureFileSync(sourcePath, targetPath)
    }
  }
})

import { writeSecureFile } from './secure-file'

const roots: string[] = []
const posixIt = process.platform === 'win32' ? it.skip : it
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function targetPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-critical-secure-file-'))
  roots.push(root)
  return join(root, 'record.json')
}

afterEach(() => {
  filesystemState.failedStage = null
  filesystemState.stages.length = 0
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('critical secure-file durability', () => {
  posixIt('flushes the temporary file, renames it, then flushes its parent', () => {
    const path = targetPath()

    writeSecureFile(path, 'critical', { durability: 'critical' })

    expect(filesystemState.stages).toEqual(['temp-fsync', 'rename', 'parent-dir-fsync'])
    expect(readFileSync(path, 'utf8')).toBe('critical')
  })

  it('rejects an unsupported platform before publishing a temporary file', () => {
    const path = targetPath()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    expect(() => writeSecureFile(path, 'critical', { durability: 'critical' })).toThrow(
      'Critical secure-file durability is unavailable on Windows.'
    )
    expect(existsSync(path)).toBe(false)
  })

  posixIt.each(['temp-fsync', 'rename', 'parent-dir-fsync'] as const)(
    'propagates a %s failure',
    (failedStage) => {
      const path = targetPath()
      filesystemState.failedStage = failedStage

      expect(() => writeSecureFile(path, 'critical', { durability: 'critical' })).toThrow(
        expect.objectContaining({ code: failedStage === 'parent-dir-fsync' ? 'ENOTSUP' : 'EIO' })
      )
    }
  )

  it('keeps best-effort durable writes independent from critical platform support', () => {
    const path = targetPath()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    expect(() => writeSecureFile(path, 'local', { durable: true })).not.toThrow()
    expect(readFileSync(path, 'utf8')).toBe('local')
  })

  posixIt('leaves the previous file intact when the critical rename is not reached', () => {
    const path = targetPath()
    writeFileSync(path, 'previous')
    filesystemState.failedStage = 'temp-fsync'

    expect(() => writeSecureFile(path, 'next', { durability: 'critical' })).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('previous')
  })
})
