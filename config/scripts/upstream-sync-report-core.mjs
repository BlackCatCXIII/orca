import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const SCP_LOCATION_PATTERN = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/
const URL_SCHEMES = new Set(['file:', 'git:', 'http:', 'https:', 'ssh:'])
const EMPTY_GIT_CONFIG = process.platform === 'win32' ? 'NUL' : '/dev/null'
const BLOCKED_ENVIRONMENT_KEYS =
  /^(?:GIT_|GCM_|GH_TOKEN$|GITHUB_TOKEN$|SSH_(?:ASKPASS|ASKPASS_REQUIRE|AUTH_SOCK|AGENT_PID)$)/i
const ISOLATED_GIT_OPTIONS = [
  '-c',
  `core.hooksPath=${EMPTY_GIT_CONFIG}`,
  '-c',
  'credential.helper=',
  '-c',
  'http.extraHeader='
]

export function isolatedGitEnvironment(inherited = process.env) {
  const environment = {}
  for (const [key, value] of Object.entries(inherited)) {
    if (!BLOCKED_ENVIRONMENT_KEYS.test(key) && value !== undefined) {
      environment[key] = value
    }
  }
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    SSH_ASKPASS_REQUIRE: 'never'
  }
}

export function isolatedGitArguments(args) {
  return [...ISOLATED_GIT_OPTIONS, ...args]
}

export class UpstreamSyncError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'UpstreamSyncError'
    this.code = code
  }
}

function runGit(cwd, args, options = {}) {
  try {
    const { env, ...commandOptions } = options
    return execFileSync('git', isolatedGitArguments(args), {
      cwd,
      encoding: 'utf8',
      env: isolatedGitEnvironment(env),
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...commandOptions
    }).trim()
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message
    throw new UpstreamSyncError('git-command-failed', `git ${args[0]} failed: ${detail}`)
  }
}

function runMerge(cwd, upstreamSha) {
  const environment = isolatedGitEnvironment()
  environment.GIT_AUTHOR_EMAIL = 'upstream-sync@invalid'
  environment.GIT_AUTHOR_NAME = 'Upstream Sync Simulation'
  environment.GIT_COMMITTER_EMAIL = 'upstream-sync@invalid'
  environment.GIT_COMMITTER_NAME = 'Upstream Sync Simulation'
  return spawnSync(
    'git',
    isolatedGitArguments(['merge', '--no-commit', '--no-ff', '--no-edit', upstreamSha]),
    {
      cwd,
      encoding: 'utf8',
      env: environment,
      maxBuffer: 64 * 1024 * 1024
    }
  )
}

function assertCleanFullRepository(repo) {
  const root = runGit(repo, ['rev-parse', '--show-toplevel'])
  if (realpathSync(root) !== realpathSync(repo)) {
    throw new UpstreamSyncError('repository-root-required', `--repo must be the Git root: ${root}`)
  }
  if (runGit(root, ['status', '--porcelain=v1', '--untracked-files=all'])) {
    throw new UpstreamSyncError(
      'dirty-repository',
      'Caller repository has tracked or untracked changes'
    )
  }
  if (runGit(root, ['rev-parse', '--is-shallow-repository']) !== 'false') {
    throw new UpstreamSyncError('shallow-repository', 'Caller repository is shallow')
  }
  return root
}

export function validateGitRef(ref) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-') || /[\0\r\n]/.test(ref)) {
    throw new UpstreamSyncError('malformed-ref', `Invalid Git ref: ${JSON.stringify(ref)}`)
  }
  if (COMMIT_PATTERN.test(ref)) {
    return ref
  }
  if (!ref.startsWith('refs/heads/')) {
    throw new UpstreamSyncError('malformed-ref', `Ref must be a full branch ref or SHA: ${ref}`)
  }
  const result = spawnSync('git', isolatedGitArguments(['check-ref-format', ref]), {
    encoding: 'utf8',
    env: isolatedGitEnvironment()
  })
  if (result.status !== 0) {
    throw new UpstreamSyncError('malformed-ref', `Invalid Git ref: ${ref}`)
  }
  return ref
}

export function validateRepositoryLocation(location, cwd = process.cwd()) {
  if (
    typeof location !== 'string' ||
    !location ||
    location.startsWith('-') ||
    /[\0\r\n]/.test(location)
  ) {
    throw new UpstreamSyncError('malformed-url', 'Repository URL/path is invalid')
  }
  if (SCP_LOCATION_PATTERN.test(location)) {
    return location
  }
  let parsed
  try {
    parsed = new URL(location)
  } catch {
    parsed = undefined
  }
  if (parsed) {
    const httpCredentials = ['http:', 'https:'].includes(parsed.protocol) && parsed.username
    if (!URL_SCHEMES.has(parsed.protocol) || parsed.password || httpCredentials) {
      throw new UpstreamSyncError('malformed-url', 'Repository URL is unsupported or credentialed')
    }
    return location
  }
  const resolved = path.resolve(cwd, location)
  if (!existsSync(resolved)) {
    throw new UpstreamSyncError('malformed-url', `Repository path does not exist: ${location}`)
  }
  return resolved
}

function parseRemoteRef(output, ref) {
  const matches = output
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .filter(([, candidate]) => candidate === ref)
  if (matches.length !== 1 || !COMMIT_PATTERN.test(matches[0][0])) {
    throw new UpstreamSyncError('missing-ref', `Remote does not advertise exactly one ${ref}`)
  }
  return matches[0][0]
}

function resolveLocationRef(location, ref, cwd) {
  if (COMMIT_PATTERN.test(ref)) {
    return ref
  }
  const output = runGit(cwd, ['ls-remote', '--exit-code', location, ref])
  return parseRemoteRef(output, ref)
}

function importLocationRef(repository, role, location, ref, expectedSha) {
  const destination = `refs/orca-sync/${role}`
  runGit(repository, ['fetch', '--no-tags', '--force', location, `${ref}:${destination}`])
  const importedSha = runGit(repository, ['rev-parse', '--verify', `${destination}^{commit}`])
  if (importedSha !== expectedSha) {
    throw new UpstreamSyncError(
      'moving-ref',
      `${role} changed while it was fetched: expected ${expectedSha}, received ${importedSha}`
    )
  }
  return importedSha
}

function unmergedPaths(repository) {
  const output = runGit(repository, ['diff', '--name-only', '-z', '--diff-filter=U'])
  return output ? output.split('\0').filter(Boolean).sort() : []
}

function changedPathDetails(repository, range) {
  const output = runGit(repository, ['diff', '--name-status', '-z', '--find-renames=50%', range])
  const tokens = output ? output.split('\0').filter(Boolean) : []
  const paths = new Set()
  const renames = []
  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index]
    const source = tokens[index + 1]
    if (!/^[A-Z][0-9]*$/.test(status) || source === undefined) {
      throw new UpstreamSyncError('git-output-invalid', 'Git emitted malformed name-status output')
    }
    paths.add(source)
    index += 2
    if (status.startsWith('R') || status.startsWith('C')) {
      const destination = tokens[index]
      if (destination === undefined) {
        throw new UpstreamSyncError('git-output-invalid', 'Git omitted a rename destination')
      }
      paths.add(destination)
      renames.push({ source, destination })
      index += 1
    }
  }
  return { paths: [...paths].sort(), renames }
}

function overlappingChangedPaths(downstream, upstream) {
  const downstreamSet = new Set(downstream.paths)
  const upstreamSet = new Set(upstream.paths)
  const overlaps = new Set(downstream.paths.filter((file) => upstreamSet.has(file)))
  for (const { source, destination } of downstream.renames) {
    if (upstreamSet.has(source) || upstreamSet.has(destination)) {
      overlaps.add(source)
      overlaps.add(destination)
    }
  }
  for (const { source, destination } of upstream.renames) {
    if (downstreamSet.has(source) || downstreamSet.has(destination)) {
      overlaps.add(source)
      overlaps.add(destination)
    }
  }
  return [...overlaps].sort()
}

function classifyPath(file) {
  if (file.startsWith('.github/')) {
    return 'ci'
  }
  if (file.startsWith('mobile/')) {
    return 'mobile'
  }
  if (file.startsWith('src/renderer/')) {
    return 'renderer'
  }
  if (file.startsWith('src/main/') || file.startsWith('src/shared/')) {
    return 'runtime'
  }
  if (file.startsWith('tests/') || /\.(?:spec|test)\.[^.]+$/.test(file)) {
    return 'tests'
  }
  if (file.startsWith('docs/') || /(?:^|\/)README(?:\.|$)/i.test(file)) {
    return 'docs'
  }
  if (file.startsWith('config/') || /(?:^|\/)(?:package|pnpm-lock)\./.test(file)) {
    return 'config'
  }
  return 'other'
}

function summarizeHotspots(paths) {
  const groups = new Map()
  for (const file of paths) {
    const category = classifyPath(file)
    const current = groups.get(category) ?? []
    current.push(file)
    groups.set(category, current)
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, files]) => ({ category, count: files.length, files }))
}

function simulateMerge(repository, downstreamSha, upstreamSha) {
  runGit(repository, ['checkout', '--detach', downstreamSha])
  const merge = runMerge(repository, upstreamSha)
  if (merge.status === 0) {
    return { mergeable: true, conflicts: [] }
  }
  const conflicts = unmergedPaths(repository)
  if (conflicts.length === 0) {
    const detail = merge.stderr?.trim() || merge.stdout?.trim() || `exit ${merge.status}`
    throw new UpstreamSyncError('merge-simulation-failed', `Disposable merge failed: ${detail}`)
  }
  return { mergeable: false, conflicts }
}

function createRepository() {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'orca-upstream-sync-'))
  const repository = path.join(temporaryRoot, 'repository')
  runGit(temporaryRoot, ['init', '--quiet', repository])
  return { temporaryRoot, repository }
}

function validateExpectedSha(role, expected, actual) {
  if (expected === undefined) {
    return
  }
  if (!COMMIT_PATTERN.test(expected)) {
    throw new UpstreamSyncError('malformed-ref', `${role} expected SHA must be 40 lowercase hex`)
  }
  if (expected !== actual) {
    throw new UpstreamSyncError('moving-ref', `${role} resolved to ${actual}, expected ${expected}`)
  }
}

export function buildUpstreamSyncReport(options, dependencies = {}) {
  const repo = assertCleanFullRepository(path.resolve(options.repo))
  const downstreamRef = validateGitRef(options.downstreamRef)
  const upstreamRef = validateGitRef(options.upstreamRef)
  const downstreamUrl = validateRepositoryLocation(options.downstreamUrl, repo)
  const upstreamUrl = validateRepositoryLocation(options.upstreamUrl, repo)
  const resolveRef = dependencies.resolveRef ?? resolveLocationRef

  const { temporaryRoot, repository } = createRepository()
  try {
    const downstreamBefore = resolveRef(downstreamUrl, downstreamRef, repository)
    const upstreamBefore = resolveRef(upstreamUrl, upstreamRef, repository)
    validateExpectedSha('downstream', options.expectedDownstreamSha, downstreamBefore)
    validateExpectedSha('upstream', options.expectedUpstreamSha, upstreamBefore)
    const downstreamSha = importLocationRef(
      repository,
      'downstream',
      downstreamUrl,
      downstreamRef,
      downstreamBefore
    )
    const upstreamSha = importLocationRef(
      repository,
      'upstream',
      upstreamUrl,
      upstreamRef,
      upstreamBefore
    )
    const downstreamAfter = resolveRef(downstreamUrl, downstreamRef, repository)
    const upstreamAfter = resolveRef(upstreamUrl, upstreamRef, repository)
    if (downstreamAfter !== downstreamBefore || upstreamAfter !== upstreamBefore) {
      throw new UpstreamSyncError('moving-ref', 'A source ref moved during the simulation')
    }
    if (runGit(repository, ['rev-parse', '--is-shallow-repository']) !== 'false') {
      throw new UpstreamSyncError('shallow-history', 'Fetched simulation repository is shallow')
    }
    const mergeBaseResult = spawnSync(
      'git',
      isolatedGitArguments(['merge-base', downstreamSha, upstreamSha]),
      {
        cwd: repository,
        encoding: 'utf8',
        env: isolatedGitEnvironment()
      }
    )
    const mergeBase = mergeBaseResult.stdout?.trim()
    if (mergeBaseResult.status !== 0 || !COMMIT_PATTERN.test(mergeBase)) {
      throw new UpstreamSyncError('missing-history', 'No complete downstream/upstream merge base')
    }
    const [downstreamAhead, upstreamAhead] = runGit(repository, [
      'rev-list',
      '--left-right',
      '--count',
      `${downstreamSha}...${upstreamSha}`
    ])
      .split(/\s+/)
      .map(Number)
    const downstreamChanges = changedPathDetails(repository, `${mergeBase}..${downstreamSha}`)
    const upstreamChanges = changedPathDetails(repository, `${mergeBase}..${upstreamSha}`)
    const overlappingPaths = overlappingChangedPaths(downstreamChanges, upstreamChanges)
    const simulation = simulateMerge(repository, downstreamSha, upstreamSha)
    const hotspots = [...new Set([...overlappingPaths, ...simulation.conflicts])].sort()
    return {
      schemaVersion: 1,
      status: simulation.mergeable ? 'mergeable' : 'conflicts',
      downstream: { ref: downstreamRef, url: downstreamUrl, sha: downstreamSha },
      upstream: { ref: upstreamRef, url: upstreamUrl, sha: upstreamSha },
      mergeBase,
      aheadBehind: { downstreamAhead, upstreamAhead },
      simulation: {
        method: 'disposable-no-commit-merge',
        callerWorktreeMutated: false,
        gitConfigIsolation: 'inherited-controls-and-hooks-disabled',
        mergeable: simulation.mergeable,
        conflicts: simulation.conflicts
      },
      changedPaths: {
        downstream: downstreamChanges.paths.length,
        upstream: upstreamChanges.paths.length,
        overlap: overlappingPaths.length
      },
      hotspots: summarizeHotspots(hotspots)
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

export function renderUpstreamSyncMarkdown(report) {
  const lines = [
    '# Orca upstream sync readiness',
    '',
    `- Status: **${report.status}**`,
    `- Downstream: \`${report.downstream.sha}\` (\`${report.downstream.ref}\`)`,
    `- Upstream: \`${report.upstream.sha}\` (\`${report.upstream.ref}\`)`,
    `- Merge base: \`${report.mergeBase}\``,
    `- Ahead/behind: downstream ${report.aheadBehind.downstreamAhead}, upstream ${report.aheadBehind.upstreamAhead}`,
    `- Changed paths: downstream ${report.changedPaths.downstream}, upstream ${report.changedPaths.upstream}, overlap ${report.changedPaths.overlap}`,
    ''
  ]
  if (report.simulation.conflicts.length > 0) {
    lines.push(
      '## Conflicts',
      '',
      ...report.simulation.conflicts.map((file) => `- \`${file}\``),
      ''
    )
  }
  lines.push('## Hotspots', '')
  if (report.hotspots.length === 0) {
    lines.push('- None')
  }
  for (const hotspot of report.hotspots) {
    lines.push(`- ${hotspot.category}: ${hotspot.count}`)
    for (const file of hotspot.files) {
      lines.push(`  - \`${file}\``)
    }
  }
  lines.push('')
  return lines.join('\n')
}
