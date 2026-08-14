import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats
} from 'node:fs'
import { join, parse, relative, sep } from 'node:path'

export type OperatorRecipeCatalogFileSystem = Readonly<{
  lstat(path: string): Stats
  realpath(path: string): string
  open(path: string): number
  fstat(fd: number): Stats
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number): number
  close(fd: number): void
}>

export const PRODUCTION_OPERATOR_CATALOG_FILE_SYSTEM: OperatorRecipeCatalogFileSystem = {
  lstat: lstatSync,
  realpath: realpathSync.native,
  open: (path) => openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)),
  fstat: fstatSync,
  read: readSync,
  close: closeSync
}

export class OperatorRecipeCatalogError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OperatorRecipeCatalogError'
  }
}

export function readVerifiedOperatorCatalogFile(
  path: string,
  maxBytes: number,
  fileSystem: OperatorRecipeCatalogFileSystem,
  executable: boolean
): Buffer {
  const pathStats = verifyImmutableRegularFile(path, fileSystem, executable)
  let descriptor: number
  try {
    descriptor = fileSystem.open(path)
  } catch {
    throw new OperatorRecipeCatalogError('Operator recipe catalog filesystem validation failed.')
  }

  let bytes: Buffer | undefined
  let failure: unknown
  try {
    const before = fileSystem.fstat(descriptor)
    verifyOpenedFile(before, pathStats, maxBytes, executable)
    bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = fileSystem.read(descriptor, bytes, offset, bytes.length - offset, offset)
      if (count <= 0) {
        throw new OperatorRecipeCatalogError(
          'Operator recipe catalog file changed during validation.'
        )
      }
      offset += count
    }
    const after = fileSystem.fstat(descriptor)
    const rebound = verifyImmutableRegularFile(path, fileSystem, executable)
    if (!sameStableFile(before, after) || !sameStableFile(after, rebound)) {
      throw new OperatorRecipeCatalogError(
        'Operator recipe catalog file changed during validation.'
      )
    }
  } catch (error) {
    failure = error
  }
  try {
    fileSystem.close(descriptor)
  } catch (error) {
    failure ??= error
  }
  if (failure || !bytes) {
    if (failure instanceof OperatorRecipeCatalogError) {
      throw failure
    }
    throw new OperatorRecipeCatalogError('Operator recipe catalog filesystem validation failed.')
  }
  return bytes
}

function verifyImmutableRegularFile(
  path: string,
  fileSystem: OperatorRecipeCatalogFileSystem,
  executable: boolean
): Stats {
  let canonical: string
  try {
    canonical = fileSystem.realpath(path)
  } catch {
    throw new OperatorRecipeCatalogError('Operator recipe catalog filesystem validation failed.')
  }
  if (canonical !== path) {
    throw new OperatorRecipeCatalogError('Operator recipe catalog symlinks are forbidden.')
  }

  const root = parse(path).root
  const rootStats = safeLstat(fileSystem, root)
  if (
    rootStats.isSymbolicLink() ||
    !rootStats.isDirectory() ||
    rootStats.uid !== 0 ||
    (rootStats.mode & 0o022) !== 0
  ) {
    throw new OperatorRecipeCatalogError(
      'Operator recipe catalog ancestry must be root-owned and not group/other writable.'
    )
  }
  const segments = relative(root, path).split(sep).filter(Boolean)
  let cursor = root
  let leafStats: Stats | undefined
  for (const [index, segment] of segments.entries()) {
    cursor = join(cursor, segment)
    const stats = safeLstat(fileSystem, cursor)
    if (stats.isSymbolicLink()) {
      throw new OperatorRecipeCatalogError('Operator recipe catalog symlinks are forbidden.')
    }
    const leaf = index === segments.length - 1
    if ((leaf && !stats.isFile()) || (!leaf && !stats.isDirectory())) {
      throw new OperatorRecipeCatalogError('Operator recipe catalog contains a non-file path.')
    }
    if (leaf && stats.nlink !== 1) {
      throw new OperatorRecipeCatalogError('Operator recipe catalog file identity is invalid.')
    }
    verifyOwnerAndMode(stats, leaf && executable)
    if (leaf) {
      leafStats = stats
    }
  }
  if (!leafStats) {
    throw new OperatorRecipeCatalogError('Operator recipe catalog filesystem validation failed.')
  }
  return leafStats
}

function safeLstat(fileSystem: OperatorRecipeCatalogFileSystem, path: string): Stats {
  try {
    return fileSystem.lstat(path)
  } catch {
    throw new OperatorRecipeCatalogError('Operator recipe catalog filesystem validation failed.')
  }
}

function verifyOwnerAndMode(stats: Stats, executable: boolean): void {
  if (stats.uid !== 0 || (stats.mode & 0o022) !== 0) {
    throw new OperatorRecipeCatalogError(
      'Operator recipe catalog ancestry must be root-owned and not group/other writable.'
    )
  }
  if (executable && (stats.mode & 0o111) === 0) {
    throw new OperatorRecipeCatalogError('Operator recipe catalog script is not executable.')
  }
}

function verifyOpenedFile(
  opened: Stats,
  pathStats: Stats,
  maxBytes: number,
  executable: boolean
): void {
  if (!sameFileIdentity(opened, pathStats) || !opened.isFile() || opened.nlink !== 1) {
    throw new OperatorRecipeCatalogError('Operator recipe catalog file identity is invalid.')
  }
  verifyOwnerAndMode(opened, executable)
  if (!Number.isSafeInteger(opened.size) || opened.size < 0 || opened.size > maxBytes) {
    throw new OperatorRecipeCatalogError('Operator recipe catalog file exceeds its size limit.')
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameStableFile(left: Stats, right: Stats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.nlink === right.nlink &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}
