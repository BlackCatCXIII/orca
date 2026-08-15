#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import {
  buildUpstreamSyncReport,
  renderUpstreamSyncMarkdown,
  UpstreamSyncError
} from './upstream-sync-report-core.mjs'

const VALUE_ARGUMENTS = new Map([
  ['--repo', 'repo'],
  ['--downstream-ref', 'downstreamRef'],
  ['--downstream-url', 'downstreamUrl'],
  ['--expected-downstream-sha', 'expectedDownstreamSha'],
  ['--upstream-ref', 'upstreamRef'],
  ['--upstream-url', 'upstreamUrl'],
  ['--expected-upstream-sha', 'expectedUpstreamSha'],
  ['--json', 'jsonPath'],
  ['--markdown', 'markdownPath']
])
const REQUIRED = [
  'downstreamRef',
  'downstreamUrl',
  'upstreamRef',
  'upstreamUrl',
  'jsonPath',
  'markdownPath'
]

export function parseUpstreamSyncArguments(argv) {
  const options = { repo: process.cwd() }
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const field = VALUE_ARGUMENTS.get(flag)
    const value = argv[index + 1]
    if (!field || value === undefined || value.startsWith('--')) {
      throw new UpstreamSyncError('invalid-arguments', `Invalid argument near ${flag ?? '<end>'}`)
    }
    if (options[field] !== undefined && field !== 'repo') {
      throw new UpstreamSyncError('invalid-arguments', `Duplicate argument: ${flag}`)
    }
    options[field] = value
  }
  for (const field of REQUIRED) {
    if (!options[field]) {
      throw new UpstreamSyncError('invalid-arguments', `Missing ${field}`)
    }
  }
  if (options.jsonPath === options.markdownPath) {
    throw new UpstreamSyncError('invalid-arguments', 'JSON and Markdown outputs must differ')
  }
  return options
}

function writeOutput(file, content) {
  const resolved = path.resolve(file)
  mkdirSync(path.dirname(resolved), { recursive: true })
  writeFileSync(resolved, content, 'utf8')
}

function errorReport(error) {
  return {
    schemaVersion: 1,
    status: 'error',
    error: {
      code: error instanceof UpstreamSyncError ? error.code : 'unexpected-error',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

export function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseUpstreamSyncArguments(argv)
    const report = buildUpstreamSyncReport(options)
    writeOutput(options.jsonPath, `${JSON.stringify(report, null, 2)}\n`)
    writeOutput(options.markdownPath, renderUpstreamSyncMarkdown(report))
    process.stdout.write(`${renderUpstreamSyncMarkdown(report)}\n`)
    return report.status === 'mergeable' ? 0 : 3
  } catch (error) {
    const report = errorReport(error)
    if (options?.jsonPath) {
      writeOutput(options.jsonPath, `${JSON.stringify(report, null, 2)}\n`)
    }
    if (options?.markdownPath) {
      writeOutput(
        options.markdownPath,
        `# Orca upstream sync readiness\n\n- Status: **error**\n- Error: \`${report.error.code}\` — ${report.error.message}\n`
      )
    }
    process.stderr.write(`upstream-sync-report: ${report.error.code}: ${report.error.message}\n`)
    return 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
