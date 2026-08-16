import { isAbsolute } from 'node:path'

const shaPattern = /^[0-9a-f]{40}$/
const platformNames = [
  'desktop-linux-x64',
  'desktop-linux-arm64',
  'desktop-windows-x64',
  'desktop-macos',
  'mobile-android',
  'mobile-ios-simulator'
]
const artifactFields = ['path', 'role', 'mediaType', 'installability', 'signingStatus']

function asObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`)
  }
  return value
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(asObject(value, label)).sort().join('\n')
  const wanted = [...expected].sort().join('\n')
  if (actual !== wanted) {
    throw new Error(`${label} fields do not match the candidate policy`)
  }
}

function assertPolicyPath(path, label, allowDirectories) {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    isAbsolute(path) ||
    path.split('/').some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)) ||
    (!allowDirectories && path.includes('/'))
  ) {
    throw new Error(`${label} must be a safe relative path`)
  }
}

export function validateCandidateArtifactPolicy(policy) {
  assertExactKeys(policy, ['schemaVersion', 'sourceRevision', 'lockfiles', 'platforms'], 'policy')
  if (policy.schemaVersion !== 1 || !shaPattern.test(policy.sourceRevision)) {
    throw new Error('Candidate artifact policy has an invalid schema or source revision')
  }
  if (!Array.isArray(policy.lockfiles) || policy.lockfiles.length === 0) {
    throw new Error('Candidate artifact policy must declare lockfiles')
  }
  for (const path of policy.lockfiles) {
    assertPolicyPath(path, 'Lockfile path', true)
  }
  if (new Set(policy.lockfiles).size !== policy.lockfiles.length) {
    throw new Error('Candidate artifact policy contains duplicate lockfiles')
  }

  const platforms = asObject(policy.platforms, 'policy platforms')
  assertExactKeys(platforms, platformNames, 'policy platforms')
  for (const [platform, artifacts] of Object.entries(platforms)) {
    if (!Array.isArray(artifacts) || artifacts.length === 0) {
      throw new Error(`Candidate platform ${platform} must declare artifacts`)
    }
    for (const artifact of artifacts) {
      assertExactKeys(artifact, artifactFields, `${platform} artifact`)
      assertPolicyPath(artifact.path, `${platform} artifact path`, false)
      for (const field of artifactFields.slice(1)) {
        if (typeof artifact[field] !== 'string' || artifact[field].length === 0) {
          throw new Error(`${platform} artifact ${field} must be a non-empty string`)
        }
      }
    }
    if (new Set(artifacts.map((artifact) => artifact.path)).size !== artifacts.length) {
      throw new Error(`Candidate platform ${platform} contains duplicate artifact paths`)
    }
  }
  return policy
}
