import { closeSync, fsyncSync, openSync, renameSync } from 'node:fs'

export function renameSecureFileSync(sourcePath: string, targetPath: string): void {
  renameSync(sourcePath, targetPath)
}

export function fsyncSecurePathSync(path: string, flags: 'r' | 'r+'): void {
  const descriptor = openSync(path, flags)
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

export function fsyncSecureFileDescriptorSync(descriptor: number): void {
  fsyncSync(descriptor)
}
