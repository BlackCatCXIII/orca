import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildUpstreamSyncReport,
  isolatedGitArguments,
  isolatedGitEnvironment,
  renderUpstreamSyncMarkdown,
  validateGitRef,
  validateRepositoryLocation
} from './upstream-sync-report-core.mjs'
import { main, parseUpstreamSyncArguments } from './upstream-sync-report.mjs'

const temporaryRoots = []

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function temporaryDirectory(name) {
  const root = mkdtempSync(path.join(tmpdir(), `${name}-`))
  temporaryRoots.push(root)
  return root
}

function initializeRepository(directory) {
  mkdirSync(directory, { recursive: true })
  git(directory, 'init', '--quiet')
  git(directory, 'config', 'user.email', 'test@example.invalid')
  git(directory, 'config', 'user.name', 'Test')
  git(directory, 'branch', '-M', 'main')
}

function commitFile(repository, file, content, message) {
  const target = path.join(repository, file)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
  git(repository, 'add', file)
  git(repository, 'commit', '--quiet', '-m', message)
  return git(repository, 'rev-parse', 'HEAD')
}

function createDivergedRepositories({
  conflict = false,
  customMergeDriver = false,
  renameEdit = false
} = {}) {
  const root = temporaryDirectory('upstream-sync-fixture')
  const seed = path.join(root, 'seed')
  const downstream = path.join(root, 'downstream')
  const upstream = path.join(root, 'upstream')
  initializeRepository(seed)
  commitFile(seed, 'shared.txt', 'base\n', 'base')
  if (customMergeDriver) {
    commitFile(seed, '.gitattributes', 'shared.txt merge=adversarial\n', 'merge attributes')
  }
  git(root, 'clone', '--quiet', seed, downstream)
  git(root, 'clone', '--quiet', seed, upstream)
  git(downstream, 'config', 'user.email', 'test@example.invalid')
  git(downstream, 'config', 'user.name', 'Test')
  git(upstream, 'config', 'user.email', 'test@example.invalid')
  git(upstream, 'config', 'user.name', 'Test')
  if (renameEdit) {
    git(downstream, 'mv', 'shared.txt', 'renamed.txt')
    git(downstream, 'commit', '--quiet', '-m', 'rename shared file')
    commitFile(upstream, 'shared.txt', 'base edited upstream\n', 'edit renamed source')
  } else if (conflict) {
    commitFile(downstream, 'shared.txt', 'downstream\n', 'downstream')
    commitFile(upstream, 'shared.txt', 'upstream\n', 'upstream')
  } else {
    commitFile(downstream, 'config/downstream.txt', 'downstream\n', 'downstream')
    commitFile(upstream, 'docs/upstream.txt', 'upstream\n', 'upstream')
  }
  return { root, downstream, upstream }
}

function reportOptions(fixture) {
  return {
    repo: fixture.downstream,
    downstreamRef: 'refs/heads/main',
    downstreamUrl: fixture.downstream,
    upstreamRef: 'refs/heads/main',
    upstreamUrl: fixture.upstream
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('upstream sync report', () => {
  it('simulates a clean merge without mutating the caller worktree', () => {
    const fixture = createDivergedRepositories()
    const beforeHead = git(fixture.downstream, 'rev-parse', 'HEAD')
    const beforeStatus = git(
      fixture.downstream,
      'status',
      '--porcelain=v1',
      '--untracked-files=all'
    )

    const report = buildUpstreamSyncReport(reportOptions(fixture))

    expect(report.status).toBe('mergeable')
    expect(report.aheadBehind).toEqual({ downstreamAhead: 1, upstreamAhead: 1 })
    expect(report.simulation).toMatchObject({
      method: 'disposable-no-commit-merge',
      callerWorktreeMutated: false,
      gitConfigIsolation: 'inherited-controls-and-hooks-disabled',
      mergeable: true,
      conflicts: []
    })
    expect(git(fixture.downstream, 'rev-parse', 'HEAD')).toBe(beforeHead)
    expect(git(fixture.downstream, 'status', '--porcelain=v1', '--untracked-files=all')).toBe(
      beforeStatus
    )
    expect(renderUpstreamSyncMarkdown(report)).toContain('Status: **mergeable**')
  })

  it('reports merge conflicts and classifies their hotspots', () => {
    const fixture = createDivergedRepositories({ conflict: true })

    const report = buildUpstreamSyncReport(reportOptions(fixture))

    expect(report.status).toBe('conflicts')
    expect(report.simulation.conflicts).toEqual(['shared.txt'])
    expect(report.hotspots).toEqual([{ category: 'other', count: 1, files: ['shared.txt'] }])
  })

  it('includes both sides of a rename when the other branch edits its source', () => {
    const fixture = createDivergedRepositories({ renameEdit: true })

    const report = buildUpstreamSyncReport(reportOptions(fixture))

    expect(report.status).toBe('mergeable')
    expect(report.changedPaths).toEqual({ downstream: 2, upstream: 1, overlap: 2 })
    expect(report.hotspots).toEqual([
      { category: 'other', count: 2, files: ['renamed.txt', 'shared.txt'] }
    ])
  })

  it('fails closed when the caller repository is dirty', () => {
    const fixture = createDivergedRepositories()
    writeFileSync(path.join(fixture.downstream, 'untracked.txt'), 'dirty\n', 'utf8')

    expect(() => buildUpstreamSyncReport(reportOptions(fixture))).toThrowError(
      expect.objectContaining({ code: 'dirty-repository' })
    )
  })

  it('fails closed when the caller repository is shallow', () => {
    const fixture = createDivergedRepositories()
    const shallow = path.join(fixture.root, 'shallow')
    git(
      fixture.root,
      'clone',
      '--quiet',
      '--depth',
      '1',
      pathToFileURL(fixture.downstream).href,
      shallow
    )

    expect(() =>
      buildUpstreamSyncReport({ ...reportOptions(fixture), repo: shallow, downstreamUrl: shallow })
    ).toThrowError(expect.objectContaining({ code: 'shallow-repository' }))
  })

  it('fails closed when either source ref moves during the fetch window', () => {
    const fixture = createDivergedRepositories()
    const downstreamSha = git(fixture.downstream, 'rev-parse', 'HEAD')
    const upstreamSha = git(fixture.upstream, 'rev-parse', 'HEAD')
    const snapshots = [downstreamSha, upstreamSha, 'f'.repeat(40), upstreamSha]

    expect(() =>
      buildUpstreamSyncReport(reportOptions(fixture), {
        resolveRef: () => snapshots.shift()
      })
    ).toThrowError(expect.objectContaining({ code: 'moving-ref' }))
  })

  it('fails closed when repositories have no shared history', () => {
    const fixture = createDivergedRepositories()
    const unrelated = path.join(fixture.root, 'unrelated')
    initializeRepository(unrelated)
    commitFile(unrelated, 'unrelated.txt', 'unrelated\n', 'unrelated')

    expect(() =>
      buildUpstreamSyncReport({ ...reportOptions(fixture), upstreamUrl: unrelated })
    ).toThrowError(expect.objectContaining({ code: 'missing-history' }))
  })

  it('rejects malformed and ambiguous refs and repository locations', () => {
    expect(() => validateGitRef('main')).toThrowError(
      expect.objectContaining({ code: 'malformed-ref' })
    )
    expect(() => validateGitRef('--upload-pack=malicious')).toThrowError(
      expect.objectContaining({ code: 'malformed-ref' })
    )
    expect(() => validateGitRef('refs/tags/v1.0.0')).toThrowError(
      expect.objectContaining({ code: 'malformed-ref' })
    )
    expect(() =>
      validateRepositoryLocation('https://user:secret@example.com/repo.git')
    ).toThrowError(expect.objectContaining({ code: 'malformed-url' }))
    expect(() => validateRepositoryLocation('https://token@example.com/repo.git')).toThrowError(
      expect.objectContaining({ code: 'malformed-url' })
    )
    expect(() => validateRepositoryLocation('--config=credential.helper=evil')).toThrowError(
      expect.objectContaining({ code: 'malformed-url' })
    )
  })

  it('quarantines system/global Git config and interactive credential prompts', () => {
    const environment = isolatedGitEnvironment({
      PATH: 'preserved',
      GIT_ASKPASS: 'attacker',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'merge.adversarial.driver',
      GIT_DIR: 'attacker',
      GIT_OBJECT_DIRECTORY: 'attacker',
      GIT_WORK_TREE: 'attacker',
      SSH_ASKPASS: 'attacker',
      SSH_AUTH_SOCK: 'attacker'
    })
    expect(environment).toMatchObject({
      PATH: 'preserved',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      SSH_ASKPASS_REQUIRE: 'never'
    })
    for (const key of [
      'GIT_ASKPASS',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'GIT_DIR',
      'GIT_OBJECT_DIRECTORY',
      'GIT_WORK_TREE',
      'SSH_ASKPASS',
      'SSH_AUTH_SOCK'
    ]) {
      expect(environment).not.toHaveProperty(key)
    }
    expect(isolatedGitArguments(['status', '--short'])).toEqual([
      '-c',
      `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
      '-c',
      'credential.helper=',
      '-c',
      'http.extraHeader=',
      'status',
      '--short'
    ])
  })

  it('does not let injected command-scope merge drivers falsify conflict truth', () => {
    const fixture = createDivergedRepositories({ conflict: true, customMergeDriver: true })
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', 'merge.adversarial.driver')
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'node -e "process.exit(0)"')

    const report = buildUpstreamSyncReport(reportOptions(fixture))

    expect(report.status).toBe('conflicts')
    expect(report.simulation.conflicts).toEqual(['shared.txt'])
  })

  it('validates expected immutable SHAs', () => {
    const fixture = createDivergedRepositories()
    expect(() =>
      buildUpstreamSyncReport({
        ...reportOptions(fixture),
        expectedUpstreamSha: '0'.repeat(40)
      })
    ).toThrowError(expect.objectContaining({ code: 'moving-ref' }))
  })

  it('writes machine and human reports before returning a conflict exit code', () => {
    const fixture = createDivergedRepositories({ conflict: true })
    const jsonPath = path.join(fixture.root, 'report', 'sync.json')
    const markdownPath = path.join(fixture.root, 'report', 'sync.md')
    const options = reportOptions(fixture)
    const exitCode = main([
      '--repo',
      options.repo,
      '--downstream-ref',
      options.downstreamRef,
      '--downstream-url',
      options.downstreamUrl,
      '--upstream-ref',
      options.upstreamRef,
      '--upstream-url',
      options.upstreamUrl,
      '--json',
      jsonPath,
      '--markdown',
      markdownPath
    ])

    expect(exitCode).toBe(3)
    expect(JSON.parse(readFileSync(jsonPath, 'utf8')).status).toBe('conflicts')
    expect(readFileSync(markdownPath, 'utf8')).toContain('## Conflicts')
  })

  it('requires explicit refs, URLs, and distinct report paths', () => {
    expect(() => parseUpstreamSyncArguments(['--repo', '.'])).toThrowError(
      expect.objectContaining({ code: 'invalid-arguments' })
    )
    expect(() =>
      parseUpstreamSyncArguments([
        '--downstream-ref',
        'refs/heads/main',
        '--downstream-url',
        '.',
        '--upstream-ref',
        'refs/heads/main',
        '--upstream-url',
        '.',
        '--json',
        'same',
        '--markdown',
        'same'
      ])
    ).toThrowError(expect.objectContaining({ code: 'invalid-arguments' }))
  })
})
