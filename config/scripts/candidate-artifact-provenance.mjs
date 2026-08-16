import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { validateCandidateArtifactPolicy } from './candidate-artifact-policy.mjs'

const scriptDirectory = import.meta.dirname
const defaultPolicyPath = resolve(scriptDirectory, '..', 'candidate-artifacts.json')
const manifestName = 'provenance.json'
const shaPattern = /^[0-9a-f]{40}$/
const sha256Pattern = /^[0-9a-f]{64}$/

async function readRegularFile(path, label) {
  const metadata = await lstat(path)
  if (!metadata.isFile()) {
    throw new Error(`${label} must be a regular file`)
  }
  return { contents: await readFile(path), metadata }
}

async function sha256(path, label) {
  const { contents } = await readRegularFile(path, label)
  return createHash('sha256').update(contents).digest('hex')
}

async function loadPolicy(policyPath = defaultPolicyPath) {
  const policy = JSON.parse(await readFile(policyPath, 'utf8'))
  return validateCandidateArtifactPolicy(policy)
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (!entry.isFile()) {
      throw new Error(`Candidate bundle contains a non-file entry: ${entry.name}`)
    }
    files.push(entry.name)
  }
  return files.sort()
}

function requirePlatform(policy, platform) {
  const artifacts = policy.platforms[platform]
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error(`Unknown candidate platform: ${platform}`)
  }
  return artifacts
}

function assertExactFiles(actual, expected, label) {
  const actualKey = [...actual].sort().join('\n')
  const expectedKey = [...expected].sort().join('\n')
  if (actualKey !== expectedKey) {
    throw new Error(
      `${label} file allowlist mismatch\nexpected:\n${expectedKey}\nactual:\n${actualKey}`
    )
  }
}

function sourceRevision(sourceRoot) {
  return execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8'
  }).trim()
}

export async function writeCandidateProvenance({
  platform,
  sourceRoot,
  artifactDirectory,
  workflowRevision,
  policyPath = defaultPolicyPath
}) {
  const policy = await loadPolicy(policyPath)
  const artifactPolicy = requirePlatform(policy, platform)
  if (!shaPattern.test(workflowRevision)) {
    throw new Error('Workflow revision must be a full lowercase commit SHA')
  }
  const revision = sourceRevision(sourceRoot)
  if (revision !== policy.sourceRevision) {
    throw new Error(`Expected source revision ${policy.sourceRevision}, got ${revision}`)
  }
  const filesBeforeWrite = await listFiles(artifactDirectory)
  assertExactFiles(
    filesBeforeWrite.filter((path) => path !== manifestName),
    artifactPolicy.map((artifact) => artifact.path),
    platform
  )

  const sourceLockfiles = []
  for (const path of policy.lockfiles) {
    sourceLockfiles.push({
      path,
      sha256: await sha256(join(sourceRoot, path), `Source lockfile ${path}`)
    })
  }
  const artifacts = []
  for (const expected of artifactPolicy) {
    const path = join(artifactDirectory, expected.path)
    const { contents, metadata } = await readRegularFile(
      path,
      `Candidate artifact ${expected.path}`
    )
    artifacts.push({
      path: expected.path,
      role: expected.role,
      mediaType: expected.mediaType,
      sizeBytes: metadata.size,
      sha256: createHash('sha256').update(contents).digest('hex'),
      installability: expected.installability,
      signingStatus: expected.signingStatus,
      publicationStatus: 'unpublished'
    })
  }
  const manifest = {
    schemaVersion: policy.schemaVersion,
    sourceRevision: revision,
    workflowRevision,
    platform,
    sourceLockfiles,
    artifacts,
    claims: {
      published: false,
      signedForDistribution: false,
      updateMetadataProduced: false
    }
  }
  await writeFile(join(artifactDirectory, manifestName), `${JSON.stringify(manifest, null, 2)}\n`)
  await verifyCandidateProvenance({
    platform,
    sourceRoot,
    artifactDirectory,
    workflowRevision,
    policyPath
  })
  return manifest
}

export async function verifyCandidateProvenance({
  platform,
  sourceRoot,
  artifactDirectory,
  workflowRevision,
  policyPath = defaultPolicyPath
}) {
  const policy = await loadPolicy(policyPath)
  const artifactPolicy = requirePlatform(policy, platform)
  assertExactFiles(
    await listFiles(artifactDirectory),
    [...artifactPolicy.map((artifact) => artifact.path), manifestName],
    platform
  )
  const manifest = JSON.parse(await readFile(join(artifactDirectory, manifestName), 'utf8'))
  const requiredKeys = [
    'schemaVersion',
    'sourceRevision',
    'workflowRevision',
    'platform',
    'sourceLockfiles',
    'artifacts',
    'claims'
  ]
  assertExactFiles(Object.keys(manifest), requiredKeys, 'provenance fields')
  if (
    manifest.schemaVersion !== policy.schemaVersion ||
    manifest.sourceRevision !== policy.sourceRevision ||
    manifest.sourceRevision !== sourceRevision(sourceRoot) ||
    manifest.workflowRevision !== workflowRevision ||
    !shaPattern.test(manifest.workflowRevision) ||
    manifest.platform !== platform
  ) {
    throw new Error('Provenance identity fields do not match the candidate policy')
  }
  if (
    manifest.claims?.published !== false ||
    manifest.claims?.signedForDistribution !== false ||
    manifest.claims?.updateMetadataProduced !== false
  ) {
    throw new Error('Candidate provenance contains an invalid publication claim')
  }
  assertExactFiles(
    Object.keys(manifest.claims),
    ['published', 'signedForDistribution', 'updateMetadataProduced'],
    'provenance claims'
  )
  assertExactFiles(
    manifest.sourceLockfiles.map((entry) => entry.path),
    policy.lockfiles,
    'lockfiles'
  )
  for (const lockfile of manifest.sourceLockfiles) {
    assertExactFiles(Object.keys(lockfile), ['path', 'sha256'], `lockfile ${lockfile.path}`)
    if (
      !sha256Pattern.test(lockfile.sha256) ||
      lockfile.sha256 !==
        (await sha256(join(sourceRoot, lockfile.path), `Source lockfile ${lockfile.path}`))
    ) {
      throw new Error(`Lockfile checksum mismatch: ${lockfile.path}`)
    }
  }
  assertExactFiles(
    manifest.artifacts.map((artifact) => artifact.path),
    artifactPolicy.map((artifact) => artifact.path),
    'artifacts'
  )
  for (const artifact of manifest.artifacts) {
    assertExactFiles(
      Object.keys(artifact),
      [
        'path',
        'role',
        'mediaType',
        'sizeBytes',
        'sha256',
        'installability',
        'signingStatus',
        'publicationStatus'
      ],
      `artifact ${artifact.path}`
    )
    const expected = artifactPolicy.find((candidate) => candidate.path === artifact.path)
    const path = join(artifactDirectory, artifact.path)
    const { contents, metadata } = await readRegularFile(
      path,
      `Candidate artifact ${artifact.path}`
    )
    if (
      !expected ||
      artifact.role !== expected.role ||
      artifact.mediaType !== expected.mediaType ||
      artifact.installability !== expected.installability ||
      artifact.signingStatus !== expected.signingStatus ||
      artifact.publicationStatus !== 'unpublished' ||
      artifact.sizeBytes !== metadata.size ||
      !sha256Pattern.test(artifact.sha256) ||
      artifact.sha256 !== createHash('sha256').update(contents).digest('hex')
    ) {
      throw new Error(`Artifact provenance mismatch: ${artifact.path}`)
    }
  }
  return manifest
}

function parseArguments(arguments_) {
  const [command, ...rest] = arguments_
  const values = { command }
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]
    const value = rest[index + 1]
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid argument: ${key}`)
    }
    values[key.slice(2)] = value
  }
  return values
}

if (process.argv[1] === import.meta.filename) {
  const options = parseArguments(process.argv.slice(2))
  const request = {
    platform: options.platform,
    sourceRoot: resolve(options.source),
    artifactDirectory: resolve(options.artifacts),
    workflowRevision: options['workflow-revision'],
    policyPath: options.policy ? resolve(options.policy) : defaultPolicyPath
  }
  if (options.command === 'write') {
    await writeCandidateProvenance(request)
  } else if (options.command === 'verify') {
    await verifyCandidateProvenance(request)
  } else {
    throw new Error('Expected write or verify command')
  }
}
