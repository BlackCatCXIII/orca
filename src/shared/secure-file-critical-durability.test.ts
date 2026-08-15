import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  __setCriticalSecureFileTestHooksForTests,
  type CriticalSecureFileStage,
  writeSecureFile
} from './secure-file'

const roots: string[] = []
const posixIt = process.platform === 'win32' ? it.skip : it

function targetPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-critical-secure-file-'))
  roots.push(root)
  return join(root, 'record.json')
}

afterEach(() => {
  __setCriticalSecureFileTestHooksForTests(null)
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('critical secure-file durability', () => {
  posixIt('flushes the temporary file, renames it, then flushes its parent', () => {
    const path = targetPath()
    const stages: CriticalSecureFileStage[] = []
    __setCriticalSecureFileTestHooksForTests({
      beforeStage: (stage) => stages.push(stage)
    })

    writeSecureFile(path, 'critical', { durability: 'critical' })

    expect(stages).toEqual(['temp-fsync', 'rename', 'parent-dir-fsync'])
    expect(readFileSync(path, 'utf8')).toBe('critical')
  })

  it('rejects an unsupported platform before publishing a temporary file', () => {
    const path = targetPath()
    __setCriticalSecureFileTestHooksForTests({ platform: 'win32' })

    expect(() => writeSecureFile(path, 'critical', { durability: 'critical' })).toThrow(
      'Critical secure-file durability is unavailable on Windows.'
    )
    expect(existsSync(path)).toBe(false)
  })

  posixIt.each(['temp-fsync', 'rename', 'parent-dir-fsync'] as const)(
    'propagates a %s failure',
    (failedStage) => {
      const path = targetPath()
      const error = Object.assign(new Error(`injected ${failedStage}`), {
        code: failedStage === 'parent-dir-fsync' ? 'ENOTSUP' : 'EIO'
      })
      __setCriticalSecureFileTestHooksForTests({
        beforeStage: (stage) => {
          if (stage === failedStage) {
            throw error
          }
        }
      })

      expect(() => writeSecureFile(path, 'critical', { durability: 'critical' })).toThrow(error)
    }
  )

  it('keeps best-effort durable writes independent from critical platform support', () => {
    const path = targetPath()
    __setCriticalSecureFileTestHooksForTests({ platform: 'win32' })

    expect(() => writeSecureFile(path, 'local', { durable: true })).not.toThrow()
    expect(readFileSync(path, 'utf8')).toBe('local')
  })

  posixIt('leaves the previous file intact when the critical rename is not reached', () => {
    const path = targetPath()
    writeFileSync(path, 'previous')
    __setCriticalSecureFileTestHooksForTests({
      beforeStage: (stage) => {
        if (stage === 'temp-fsync') {
          throw new Error('injected temp fsync')
        }
      }
    })

    expect(() => writeSecureFile(path, 'next', { durability: 'critical' })).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('previous')
  })
})
