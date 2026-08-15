import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  type BigIntStats
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { readNodeFileDescriptorSyncWithinLimit } from './node-bounded-file-reader'
import {
  fsyncSecureDirectoryDescriptorSync,
  fsyncSecureFileDescriptorSync
} from './secure-file-filesystem'

type ConditionalAuthority<T> = {
  value: T
  requiresCriticalDurability: boolean
}

export function readConditionallyAuthoritativeSecureFileSync<T>(
  targetPath: string,
  maxBytes: number,
  decode: (buffer: Buffer) => ConditionalAuthority<T>
): T {
  // Why: profile roots may be aliases; canonicalize only the parent so the store entry itself stays no-follow.
  const canonicalTargetPath = join(realpathSync(dirname(targetPath)), basename(targetPath))
  const beforeOpen = snapshotPath(canonicalTargetPath)
  assertRegularFile(beforeOpen)
  const descriptor = openSync(canonicalTargetPath, noFollowOpenFlags(false))
  try {
    const beforeRead = snapshotDescriptor(descriptor)
    assertRegularFile(beforeRead)
    assertUnchangedSnapshot(beforeOpen, beforeRead)
    assertPathStillObserved(canonicalTargetPath, beforeRead, false)
    const observed = readNodeFileDescriptorSyncWithinLimit(descriptor, maxBytes).buffer
    const afterRead = snapshotDescriptor(descriptor)
    assertUnchangedSnapshot(beforeRead, afterRead)
    assertSnapshotSize(afterRead, observed)

    const decoded = decode(observed)
    if (!decoded.requiresCriticalDurability) {
      return decoded.value
    }
    if (process.platform === 'win32') {
      throw new Error('Critical secure-file durability is unavailable on Windows.')
    }

    fsyncSecureFileDescriptorSync(descriptor)
    assertDescriptorStillObserved(descriptor, maxBytes, afterRead, observed)
    assertPathStillObserved(canonicalTargetPath, afterRead, false)
    return withAuthoritativeParentDirectory(canonicalTargetPath, () => {
      assertDescriptorStillObserved(descriptor, maxBytes, afterRead, observed)
      assertPathStillObserved(canonicalTargetPath, afterRead, false)
      return decoded.value
    })
  } finally {
    closeSync(descriptor)
  }
}

function withAuthoritativeParentDirectory<T>(targetPath: string, finish: () => T): T {
  const parentPath = dirname(targetPath)
  const beforeOpen = snapshotPath(parentPath)
  assertDirectory(beforeOpen)
  const descriptor = openSync(parentPath, noFollowOpenFlags(true))
  try {
    const observed = snapshotDescriptor(descriptor)
    assertDirectory(observed)
    assertUnchangedSnapshot(beforeOpen, observed)
    assertPathStillObserved(parentPath, observed, true)
    fsyncSecureDirectoryDescriptorSync(descriptor)
    const afterFsync = snapshotDescriptor(descriptor)
    assertUnchangedSnapshot(observed, afterFsync)
    assertPathStillObserved(parentPath, observed, true)
    return finish()
  } finally {
    closeSync(descriptor)
  }
}

function assertDescriptorStillObserved(
  descriptor: number,
  maxBytes: number,
  observedStats: BigIntStats,
  observedBytes: Buffer
): void {
  const currentBytes = readNodeFileDescriptorSyncWithinLimit(descriptor, maxBytes).buffer
  const currentStats = snapshotDescriptor(descriptor)
  assertUnchangedSnapshot(observedStats, currentStats)
  assertSnapshotSize(currentStats, currentBytes)
  if (!currentBytes.equals(observedBytes)) {
    throw new Error('Secure file bytes changed while establishing durability authority.')
  }
}

function assertPathStillObserved(
  targetPath: string,
  observed: BigIntStats,
  directory: boolean
): void {
  const current = snapshotPath(targetPath)
  if (directory) {
    assertDirectory(current)
  } else {
    assertRegularFile(current)
  }
  assertUnchangedSnapshot(observed, current)
}

function snapshotDescriptor(descriptor: number): BigIntStats {
  return fstatSync(descriptor, { bigint: true })
}

function snapshotPath(targetPath: string): BigIntStats {
  const stats = lstatSync(targetPath, { bigint: true })
  if (stats.isSymbolicLink()) {
    throw new Error('Secure file authority does not follow symbolic links.')
  }
  return stats
}

function noFollowOpenFlags(directory: boolean): number | 'r' {
  if (process.platform === 'win32') {
    return 'r'
  }
  return (
    constants.O_RDONLY |
    constants.O_NONBLOCK |
    constants.O_NOFOLLOW |
    (directory ? constants.O_DIRECTORY : 0)
  )
}

function assertRegularFile(stats: BigIntStats): void {
  if (!stats.isFile()) {
    throw new Error('Secure file authority requires a regular file.')
  }
}

function assertDirectory(stats: BigIntStats): void {
  if (!stats.isDirectory()) {
    throw new Error('Secure file authority requires a parent directory.')
  }
}

function assertSnapshotSize(stats: BigIntStats, bytes: Buffer): void {
  if (stats.size !== BigInt(bytes.byteLength)) {
    throw new Error('Secure file size changed while establishing durability authority.')
  }
}

function assertUnchangedSnapshot(observed: BigIntStats, current: BigIntStats): void {
  if (
    observed.dev !== current.dev ||
    observed.ino !== current.ino ||
    observed.size !== current.size ||
    observed.mtimeNs !== current.mtimeNs ||
    observed.ctimeNs !== current.ctimeNs
  ) {
    throw new Error('Secure file identity changed while establishing durability authority.')
  }
}
