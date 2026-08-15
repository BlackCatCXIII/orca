import { stringifyJsonWithinByteLimit } from './node-bounded-json-stringify'
import { writeSecureFile } from './secure-file'

export function writeSecureJsonFileWithinLimit(
  targetPath: string,
  value: unknown,
  maxBytes: number,
  options: { durable?: boolean } = {}
): void {
  writeSecureFile(targetPath, stringifyJsonWithinByteLimit(value, maxBytes).serialized, options)
}

export function writeDurableSecureJsonFileWithinLimit(
  targetPath: string,
  value: unknown,
  maxBytes: number
): void {
  writeSecureFile(targetPath, stringifyJsonWithinByteLimit(value, maxBytes).serialized, {
    durable: true
  })
}

export function writeCriticalSecureJsonFileWithinLimit(
  targetPath: string,
  value: unknown,
  maxBytes: number
): void {
  writeSecureFile(targetPath, stringifyJsonWithinByteLimit(value, maxBytes).serialized, {
    durability: 'critical'
  })
}
