import { spawn } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import type { CommandHandler } from '../dispatch'
import { formatCliStatus, formatStatus, printResult } from '../format'
import { RuntimeClientError, serveOrcaApp } from '../runtime-client'
import { stripElectronRunAsNode } from '../runtime/launch'

function envRecord(): Record<string, string> {
  // Why: the `orca` launcher runs Orca's Electron binary as Node, so this CLI
  // process carries ELECTRON_RUN_AS_NODE=1. Strip it before it reaches the
  // spawned `claude` (and any nested Electron it launches), which would
  // otherwise be forced into headless plain-Node mode.
  const env = stripElectronRunAsNode(process.env)
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

function withTeammateModeAuto(args: string[]): string[] {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--teammate-mode' || arg.startsWith('--teammate-mode=')) {
      return args
    }
  }
  return ['--teammate-mode', 'auto', ...args]
}

async function runClaudeAgentTeams(env: Record<string, string>, args: string[]): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn('claude', withTeammateModeAuto(args), {
      stdio: 'inherit',
      env
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (typeof code === 'number') {
        resolve(code)
        return
      }
      resolve(signal ? 1 : 0)
    })
  })
}

function getOptionalServePort(flags: Map<string, string | boolean>): string | null {
  if (!flags.has('port')) {
    return null
  }
  const rawPort = flags.get('port')
  if (typeof rawPort !== 'string' || rawPort.length === 0) {
    throw new RuntimeClientError('invalid_argument', 'Missing value for --port.')
  }
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RuntimeClientError('invalid_argument', `Invalid --port value: ${rawPort}`)
  }
  return rawPort
}

function getOperatorRecipeCatalogFlags(flags: Map<string, string | boolean>): {
  path: string
  sha256: string
} | null {
  const hasPath = flags.has('operator-recipe-catalog')
  const hasDigest = flags.has('operator-recipe-catalog-sha256')
  if (hasPath !== hasDigest) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Operator recipe catalog path and SHA-256 flags must be provided together.'
    )
  }
  if (!hasPath) {
    return null
  }
  const path = flags.get('operator-recipe-catalog')
  const sha256 = flags.get('operator-recipe-catalog-sha256')
  if (
    (typeof path === 'string' && path.includes('\u0000')) ||
    (typeof sha256 === 'string' && sha256.includes('\u0000'))
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Operator recipe catalog flags must not be repeated.'
    )
  }
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Operator recipe catalog path must be absolute and normalized.'
    )
  }
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Operator recipe catalog digest must be lowercase SHA-256.'
    )
  }
  if (flags.get('no-pairing') !== true) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Operator recipe catalog mode requires --no-pairing.'
    )
  }
  if (
    flags.get('mobile-pairing') === true ||
    flags.get('recipe-json') === true ||
    flags.has('project-root')
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Operator recipe catalog mode rejects mobile pairing, recipe JSON, and --project-root.'
    )
  }
  return { path, sha256 }
}

export const CORE_HANDLERS: Record<string, CommandHandler> = {
  'claude-teams': async ({ client, rawArgs }) => {
    if (process.platform === 'win32') {
      throw new RuntimeClientError(
        'unsupported_platform',
        'Claude Agent Teams native panes are not supported on Windows.'
      )
    }
    const paneKey = process.env.ORCA_PANE_KEY
    if (!paneKey) {
      throw new RuntimeClientError(
        'invalid_environment',
        'orca claude-teams must be run inside an Orca terminal.'
      )
    }
    const response = await client.call<{ launch: { env: Record<string, string> } }>(
      'agentTeams.prepareLaunch',
      {
        paneKey,
        env: envRecord()
      }
    )
    process.exitCode = await runClaudeAgentTeams(
      {
        ...envRecord(),
        ...response.result.launch.env
      },
      rawArgs ?? []
    )
  },
  open: async ({ client, json }) => {
    const result = await client.openOrca()
    printResult(result, json, formatCliStatus)
  },
  serve: async ({ flags, json }) => {
    const operatorRecipeCatalog = getOperatorRecipeCatalogFlags(flags)
    if (flags.get('no-pairing') === true && flags.get('mobile-pairing') === true) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Use either --mobile-pairing or --no-pairing, not both.'
      )
    }
    if (flags.get('recipe-json') === true && flags.get('no-pairing') === true) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Recipe JSON output requires runtime pairing; remove --no-pairing.'
      )
    }
    if (flags.get('recipe-json') === true && flags.get('mobile-pairing') === true) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Recipe JSON output requires runtime pairing; remove --mobile-pairing.'
      )
    }
    const projectRoot =
      typeof flags.get('project-root') === 'string' ? (flags.get('project-root') as string) : null
    if (flags.get('recipe-json') === true && !projectRoot) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Recipe JSON output requires --project-root.'
      )
    }
    const port = getOptionalServePort(flags)
    const exitCode = await serveOrcaApp({
      json,
      port,
      pairingAddress:
        typeof flags.get('pairing-address') === 'string'
          ? (flags.get('pairing-address') as string)
          : null,
      noPairing: flags.get('no-pairing') === true,
      mobilePairing: flags.get('mobile-pairing') === true,
      recipeJson: flags.get('recipe-json') === true,
      projectRoot,
      ...(operatorRecipeCatalog
        ? {
            operatorRecipeCatalogPath: operatorRecipeCatalog.path,
            operatorRecipeCatalogSha256: operatorRecipeCatalog.sha256
          }
        : {})
    })
    process.exitCode = exitCode
  },
  status: async ({ client, json }) => {
    const result = await client.getCliStatus()
    if (!json && !result.result.runtime.reachable) {
      process.exitCode = 1
    }
    printResult(result, json, formatStatus)
  }
}
