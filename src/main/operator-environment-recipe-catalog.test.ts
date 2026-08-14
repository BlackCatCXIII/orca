import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadOperatorEnvironmentRecipeCatalog,
  type OperatorRecipeCatalogFileSystem
} from './operator-environment-recipe-catalog'

const roots: string[] = []

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function rootOwnedFileSystem(
  mutate?: (path: string, stats: Stats) => Partial<Pick<Stats, 'uid' | 'mode'>>
): OperatorRecipeCatalogFileSystem {
  const descriptorPaths = new Map<number, string>()
  const normalize = (path: string, stats: Stats): Stats => {
    const overrides = mutate?.(path, stats) ?? {}
    return Object.assign(Object.create(stats), stats, {
      uid: 0,
      mode: stats.mode & ~0o022,
      ...overrides
    }) as Stats
  }
  return {
    realpath: realpathSync.native,
    lstat: (path) => normalize(path, lstatSync(path)),
    open: (path) => {
      const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      descriptorPaths.set(descriptor, path)
      return descriptor
    },
    fstat: (descriptor) => {
      const path = descriptorPaths.get(descriptor)
      if (!path) {
        throw new Error('Unknown descriptor')
      }
      return normalize(path, fstatSync(descriptor))
    },
    read: readSync,
    close: (descriptor) => {
      descriptorPaths.delete(descriptor)
      closeSync(descriptor)
    }
  }
}

function fixture(
  overrides: Record<string, unknown> = {},
  scriptPath = 'scripts/create.sh'
): { root: string; catalogPath: string; catalogDigest: string; scriptPath: string } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'orca-operator-catalog-')))
  roots.push(root)
  const absoluteScriptPath = join(root, ...scriptPath.split('/'))
  mkdirSync(dirname(absoluteScriptPath), { recursive: true })
  const script = '#!/bin/sh\nprintf ready\\n\n'
  writeFileSync(absoluteScriptPath, script, { mode: 0o755 })
  const catalog = {
    schemaVersion: 1,
    recipes: [
      {
        id: 'cloud-box',
        name: 'Cloud box',
        checkoutMode: 'provisioned-root',
        lifecycle: { create: { path: scriptPath, sha256: sha256(script) } }
      }
    ],
    ...overrides
  }
  const bytes = `${JSON.stringify(catalog)}\n`
  const catalogPath = join(root, 'catalog.json')
  writeFileSync(catalogPath, bytes, { mode: 0o644 })
  return { root, catalogPath, catalogDigest: sha256(bytes), scriptPath: absoluteScriptPath }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('operator environment recipe catalog', () => {
  it('resolves one provisioned-root recipe to exact absolute executable scripts', () => {
    const input = fixture()
    const catalog = loadOperatorEnvironmentRecipeCatalog({
      catalogPath: input.catalogPath,
      sha256: input.catalogDigest,
      fileSystem: rootOwnedFileSystem()
    })

    expect(catalog.listRecipes()).toEqual([
      {
        id: 'cloud-box',
        name: 'Cloud box',
        checkoutMode: 'provisioned-root',
        create: input.scriptPath
      }
    ])
    expect(catalog.status).toEqual({
      enabled: true,
      digest: input.catalogDigest,
      recipeIds: ['cloud-box']
    })
    expect(JSON.stringify(catalog.status)).not.toContain(input.root)
  })

  it('rejects the wrong catalog digest without exposing the path', () => {
    const input = fixture()
    const error = (() => {
      try {
        loadOperatorEnvironmentRecipeCatalog({
          catalogPath: input.catalogPath,
          sha256: '0'.repeat(64),
          fileSystem: rootOwnedFileSystem()
        })
      } catch (caught) {
        return caught
      }
      return undefined
    })()

    expect(String(error)).toContain('digest mismatch')
    expect(String(error)).not.toContain(input.root)
  })

  it.each([
    ['unknown key', { extra: true }],
    [
      'duplicate id',
      {
        recipes: [
          {
            id: 'same',
            name: 'One',
            checkoutMode: 'provisioned-root',
            lifecycle: { create: { path: 'scripts/create.sh', sha256: '0'.repeat(64) } }
          },
          {
            id: 'same',
            name: 'Two',
            checkoutMode: 'provisioned-root',
            lifecycle: { create: { path: 'scripts/other.sh', sha256: '0'.repeat(64) } }
          }
        ]
      }
    ],
    [
      'duplicate path',
      {
        recipes: [
          {
            id: 'same',
            name: 'One',
            checkoutMode: 'provisioned-root',
            lifecycle: {
              create: { path: 'scripts/create.sh', sha256: '0'.repeat(64) },
              destroy: { path: 'scripts/create.sh', sha256: '0'.repeat(64) }
            }
          }
        ]
      }
    ],
    [
      'traversal',
      {
        recipes: [
          {
            id: 'escape',
            name: 'Escape',
            checkoutMode: 'provisioned-root',
            lifecycle: { create: { path: '../escape.sh', sha256: '0'.repeat(64) } }
          }
        ]
      }
    ],
    [
      'backslash',
      {
        recipes: [
          {
            id: 'escape',
            name: 'Escape',
            checkoutMode: 'provisioned-root',
            lifecycle: { create: { path: 'scripts\\escape.sh', sha256: '0'.repeat(64) } }
          }
        ]
      }
    ]
  ])('rejects %s contract input', (_name, overrides) => {
    const input = fixture(overrides)

    expect(() =>
      loadOperatorEnvironmentRecipeCatalog({
        catalogPath: input.catalogPath,
        sha256: input.catalogDigest,
        fileSystem: rootOwnedFileSystem()
      })
    ).toThrow(/catalog|script/i)
  })

  it.each([
    [
      'top-level',
      (source: string) =>
        source.replace('"schemaVersion":1,', '"schemaVersion":1,"schemaVersion":1,')
    ],
    [
      'recipe',
      (source: string) => source.replace('"id":"cloud-box",', '"id":"cloud-box","id":"cloud-box",')
    ],
    [
      'lifecycle',
      (source: string) => source.replace(/"create":(\{[^}]+\})/, '"create":$1,"create":$1')
    ],
    [
      'script',
      (source: string) =>
        source.replace(
          '"path":"scripts/create.sh",',
          '"path":"scripts/create.sh","\\u0070ath":"scripts/create.sh",'
        )
    ]
  ])('rejects duplicate JSON keys in the %s object', (_name, transform) => {
    const input = fixture()
    const bytes = transform(readFileSync(input.catalogPath, 'utf8'))
    writeFileSync(input.catalogPath, bytes, { mode: 0o644 })

    expect(() =>
      loadOperatorEnvironmentRecipeCatalog({
        catalogPath: input.catalogPath,
        sha256: sha256(bytes),
        fileSystem: rootOwnedFileSystem()
      })
    ).toThrow(/contract is invalid/)
  })

  it('rejects JSON nesting beyond the catalog contract bound', () => {
    const input = fixture()
    const source = readFileSync(input.catalogPath, 'utf8').trimEnd()
    const bytes = source.replace(/}$/, `,"extra":${'['.repeat(20)}null${']'.repeat(20)}}`)
    writeFileSync(input.catalogPath, bytes, { mode: 0o644 })

    expect(() =>
      loadOperatorEnvironmentRecipeCatalog({
        catalogPath: input.catalogPath,
        sha256: sha256(bytes),
        fileSystem: rootOwnedFileSystem()
      })
    ).toThrow(/contract is invalid/)
  })

  it('rejects malformed UTF-8 before JSON parsing', () => {
    const input = fixture()
    const bytes = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d])
    writeFileSync(input.catalogPath, bytes, { mode: 0o644 })

    expect(() =>
      loadOperatorEnvironmentRecipeCatalog({
        catalogPath: input.catalogPath,
        sha256: sha256(bytes),
        fileSystem: rootOwnedFileSystem()
      })
    ).toThrow(/contract is invalid/)
  })

  it('rejects symlinked catalog, script, and ancestor paths', () => {
    const catalogLink = fixture()
    const linkedCatalog = join(catalogLink.root, 'catalog-link.json')
    symlinkSync(catalogLink.catalogPath, linkedCatalog)
    expect(() =>
      loadOperatorEnvironmentRecipeCatalog({
        catalogPath: linkedCatalog,
        sha256: catalogLink.catalogDigest,
        fileSystem: rootOwnedFileSystem()
      })
    ).toThrow(/symlink/)

    const scriptLink = fixture()
    const realScript = join(scriptLink.root, 'real-create.sh')
    writeFileSync(realScript, readFileSync(scriptLink.scriptPath), { mode: 0o755 })
    rmSync(scriptLink.scriptPath)
    symlinkSync(realScript, scriptLink.scriptPath)
    expect(() =>
      loadOperatorEnvironmentRecipeCatalog({
        catalogPath: scriptLink.catalogPath,
        sha256: scriptLink.catalogDigest,
        fileSystem: rootOwnedFileSystem()
      })
    ).toThrow(/symlink/)

    const ancestorLink = fixture()
    const linkedRoot = join(
      dirname(ancestorLink.root),
      `${ancestorLink.root.split('/').at(-1)}-link`
    )
    roots.push(linkedRoot)
    symlinkSync(ancestorLink.root, linkedRoot)
    expect(() =>
      loadOperatorEnvironmentRecipeCatalog({
        catalogPath: join(linkedRoot, 'catalog.json'),
        sha256: ancestorLink.catalogDigest,
        fileSystem: rootOwnedFileSystem()
      })
    ).toThrow(/symlink/)
  })

  it('rejects non-files and owner or mode drift', () => {
    const nonFile = fixture()
    rmSync(nonFile.scriptPath)
    mkdirSync(nonFile.scriptPath)
    expect(() =>
      loadOperatorEnvironmentRecipeCatalog({
        catalogPath: nonFile.catalogPath,
        sha256: nonFile.catalogDigest,
        fileSystem: rootOwnedFileSystem()
      })
    ).toThrow(/non-file/)

    const ownerDrift = fixture()
    expect(() =>
      loadOperatorEnvironmentRecipeCatalog({
        catalogPath: ownerDrift.catalogPath,
        sha256: ownerDrift.catalogDigest,
        fileSystem: rootOwnedFileSystem((path) =>
          path === ownerDrift.scriptPath ? { uid: 501 } : {}
        )
      })
    ).toThrow(/root-owned/)

    const modeDrift = fixture()
    expect(() =>
      loadOperatorEnvironmentRecipeCatalog({
        catalogPath: modeDrift.catalogPath,
        sha256: modeDrift.catalogDigest,
        fileSystem: rootOwnedFileSystem((path, stats) =>
          path === modeDrift.scriptPath ? { mode: stats.mode | 0o020 } : {}
        )
      })
    ).toThrow(/root-owned/)

    const nonExecutable = fixture()
    chmodSync(nonExecutable.scriptPath, 0o644)
    expect(() =>
      loadOperatorEnvironmentRecipeCatalog({
        catalogPath: nonExecutable.catalogPath,
        sha256: nonExecutable.catalogDigest,
        fileSystem: rootOwnedFileSystem()
      })
    ).toThrow(/not executable/)
  })

  it('revalidates catalog and script bytes before every recipe resolution', () => {
    const changedScript = fixture()
    const catalog = loadOperatorEnvironmentRecipeCatalog({
      catalogPath: changedScript.catalogPath,
      sha256: changedScript.catalogDigest,
      fileSystem: rootOwnedFileSystem()
    })
    writeFileSync(changedScript.scriptPath, '#!/bin/sh\nprintf changed\\n\n', { mode: 0o755 })
    expect(() => catalog.resolveRecipe('cloud-box')).toThrow(/script digest mismatch/)

    const changedCatalog = fixture()
    const second = loadOperatorEnvironmentRecipeCatalog({
      catalogPath: changedCatalog.catalogPath,
      sha256: changedCatalog.catalogDigest,
      fileSystem: rootOwnedFileSystem()
    })
    writeFileSync(changedCatalog.catalogPath, '{}\n', { mode: 0o644 })
    expect(() => second.resolveRecipe('cloud-box')).toThrow(/catalog digest mismatch/)
  })

  it('fails closed when script permissions drift after startup', () => {
    const input = fixture()
    let writable = false
    const catalog = loadOperatorEnvironmentRecipeCatalog({
      catalogPath: input.catalogPath,
      sha256: input.catalogDigest,
      fileSystem: rootOwnedFileSystem((path, stats) =>
        path === input.scriptPath && writable ? { mode: stats.mode | 0o020 } : {}
      )
    })

    writable = true
    expect(() => catalog.resolveRecipe('cloud-box')).toThrow(/root-owned/)
  })

  it('rejects hard links and descriptor/path identity swaps', () => {
    const hardLinked = fixture()
    linkSync(hardLinked.scriptPath, join(hardLinked.root, 'second-create.sh'))
    expect(() =>
      loadOperatorEnvironmentRecipeCatalog({
        catalogPath: hardLinked.catalogPath,
        sha256: hardLinked.catalogDigest,
        fileSystem: rootOwnedFileSystem()
      })
    ).toThrow(/identity/)

    const swapped = fixture()
    const boundary = rootOwnedFileSystem()
    const originalOpen = boundary.open
    let replaced = false
    expect(() =>
      loadOperatorEnvironmentRecipeCatalog({
        catalogPath: swapped.catalogPath,
        sha256: swapped.catalogDigest,
        fileSystem: {
          ...boundary,
          open: (path) => {
            if (!replaced && path === swapped.catalogPath) {
              replaced = true
              const bytes = readFileSync(path)
              rmSync(path)
              writeFileSync(path, bytes, { mode: 0o644 })
            }
            return originalOpen(path)
          }
        }
      })
    ).toThrow(/identity/)
  })

  it.each(['in-place rewrite', 'hardlink creation'] as const)(
    'rejects a post-read %s before binding catalog bytes',
    (race) => {
      const input = fixture()
      const boundary = rootOwnedFileSystem()
      const originalLstat = boundary.lstat
      let catalogStats = 0
      expect(() =>
        loadOperatorEnvironmentRecipeCatalog({
          catalogPath: input.catalogPath,
          sha256: input.catalogDigest,
          fileSystem: {
            ...boundary,
            lstat: (path) => {
              if (path === input.catalogPath && ++catalogStats === 2) {
                if (race === 'hardlink creation') {
                  linkSync(path, join(input.root, 'late-link.json'))
                } else {
                  const bytes = readFileSync(path)
                  bytes[0] = bytes[0] === 0x7b ? 0x5b : 0x7b
                  writeFileSync(path, bytes, { mode: 0o644 })
                }
              }
              return originalLstat(path)
            }
          }
        })
      ).toThrow(/identity|changed/)
    }
  )

  it('caps file sizes before allocating or reading their bytes', () => {
    const input = fixture()
    const oversized = Buffer.alloc(64 * 1024 + 1)
    writeFileSync(input.catalogPath, oversized, { mode: 0o644 })

    expect(() =>
      loadOperatorEnvironmentRecipeCatalog({
        catalogPath: input.catalogPath,
        sha256: sha256(oversized),
        fileSystem: rootOwnedFileSystem()
      })
    ).toThrow(/size limit/)
  })

  it('keeps production ownership checks enabled when no boundary is injected', () => {
    const input = fixture()

    expect(() =>
      loadOperatorEnvironmentRecipeCatalog({
        catalogPath: input.catalogPath,
        sha256: input.catalogDigest
      })
    ).toThrow(/root-owned/)
  })
})
