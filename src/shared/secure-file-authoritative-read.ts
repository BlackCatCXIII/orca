import { closeSync, fstatSync, openSync, statSync, type BigIntStats } from 'node:fs'
import { dirname } from 'node:path'
import { readNodeFileDescriptorSyncWithinLimit } from './node-bounded-file-reader'
import { fsyncSecureFileDescriptorSync, fsyncSecurePathSync } from './secure-file-filesystem'

type ConditionalAuthority<T> = {
  value: T
  requiresCriticalDurability: boolean
}

export function readConditionallyAuthoritativeSecureFileSync<T>(
  targetPath: string,
  maxBytes: number,
  decode: (buffer: Buffer) => ConditionalAuthority<T>
): T {
  const descriptor = openSync(targetPath, 'r')
  try {
    const beforeRead = snapshotDescriptor(descriptor)
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
    assertPathStillObserved(targetPath, afterRead)
    fsyncSecurePathSync(dirname(targetPath), 'r')
    assertDescriptorStillObserved(descriptor, maxBytes, afterRead, observed)
    assertPathStillObserved(targetPath, afterRead)
    return decoded.value
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

function assertPathStillObserved(targetPath: string, observed: BigIntStats): void {
  const current = statSync(targetPath, { bigint: true })
  assertUnchangedSnapshot(observed, current)
}

function snapshotDescriptor(descriptor: number): BigIntStats {
  return fstatSync(descriptor, { bigint: true })
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
