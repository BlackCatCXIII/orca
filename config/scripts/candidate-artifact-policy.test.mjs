import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { validateCandidateArtifactPolicy } from './candidate-artifact-policy.mjs'
import { writeCandidateProvenance } from './candidate-artifact-provenance.mjs'

const canonicalPolicyPath = resolve('config/candidate-artifacts.json')

async function canonicalPolicy() {
  return JSON.parse(await readFile(canonicalPolicyPath, 'utf8'))
}

function git(directory, arguments_) {
  return execFileSync('git', ['-C', directory, ...arguments_], { encoding: 'utf8' }).trim()
}

async function provenanceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-candidate-policy-'))
  const sourceRoot = join(root, 'source')
  const artifactDirectory = join(root, 'artifacts')
  const policy = await canonicalPolicy()
  await mkdir(sourceRoot)
  await mkdir(artifactDirectory)
  for (const path of policy.lockfiles) {
    const destination = join(sourceRoot, path)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(resolve(path), destination)
  }
  git(sourceRoot, ['init', '--quiet'])
  git(sourceRoot, ['add', '--all'])
  git(sourceRoot, [
    '-c',
    'user.name=Candidate Test',
    '-c',
    'user.email=candidate-test@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'candidate policy fixture'
  ])
  policy.sourceRevision = git(sourceRoot, ['rev-parse', 'HEAD'])
  const policyPath = join(root, 'candidate-artifacts.json')
  await writeFile(policyPath, JSON.stringify(policy))
  return { artifactDirectory, policyPath, root, sourceRoot }
}

const policyMutations = [
  ['unknown policy field', (policy) => (policy.unknown = true)],
  ['missing platform', (policy) => delete policy.platforms['mobile-android']],
  ['unknown artifact field', (policy) => (policy.platforms['mobile-android'][0].unknown = true)],
  ['lockfile traversal', (policy) => (policy.lockfiles[0] = '../pnpm-lock.yaml')],
  [
    'artifact traversal',
    (policy) => (policy.platforms['mobile-android'][0].path = '../candidate.apk')
  ],
  ['Windows path traversal', (policy) => (policy.lockfiles[0] = '..\\pnpm-lock.yaml')]
]

for (const [name, mutate] of policyMutations) {
  test(`rejects ${name}`, async () => {
    const policy = await canonicalPolicy()
    mutate(policy)
    expect(() => validateCandidateArtifactPolicy(policy)).toThrow()
  })
}

test('rejects symlinked source lockfiles', async () => {
  const fixture = await provenanceFixture()
  try {
    const lockfile = join(fixture.sourceRoot, 'pnpm-lock.yaml')
    await rm(lockfile)
    await symlink(fixture.sourceRoot, lockfile, 'junction')
    await writeFile(join(fixture.artifactDirectory, 'orca-desktop-windows-x64.exe'), 'candidate')
    await expect(
      writeCandidateProvenance({
        platform: 'desktop-windows-x64',
        sourceRoot: fixture.sourceRoot,
        artifactDirectory: fixture.artifactDirectory,
        workflowRevision: '1111111111111111111111111111111111111111',
        policyPath: fixture.policyPath
      })
    ).rejects.toThrow(/Source lockfile pnpm-lock.yaml must be a regular file/)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('rejects non-file candidate artifacts', async () => {
  const fixture = await provenanceFixture()
  try {
    await mkdir(join(fixture.artifactDirectory, 'orca-desktop-windows-x64.exe'))
    await expect(
      writeCandidateProvenance({
        platform: 'desktop-windows-x64',
        sourceRoot: fixture.sourceRoot,
        artifactDirectory: fixture.artifactDirectory,
        workflowRevision: '1111111111111111111111111111111111111111',
        policyPath: fixture.policyPath
      })
    ).rejects.toThrow(/non-file entry/)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})
