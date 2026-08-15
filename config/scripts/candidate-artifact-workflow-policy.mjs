import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { parse } from 'yaml'
import { validateCandidateArtifactPolicy } from './candidate-artifact-policy.mjs'

const workflowRevision = '${{ github.workflow_sha }}'
const checkoutAction = 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683'
const pnpmAction = 'pnpm/action-setup@f2b2b233b538f500472c7274c7012f57857d8ce0'
const nodeAction = 'actions/setup-node@60edb5dd545a775178f52524783378180af0d1f8'
const uploadAction = 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02'
const approvedActions = new Set([checkoutAction, pnpmAction, nodeAction, uploadAction])
const expectedWorkflowDigest = '30a88f5002dbba1d90907815bc1bee76df1655d2b40b3dd865481dd27c2252b9'

const buildJobs = {
  'desktop-linux-x64': {
    runner: 'ubuntu-latest',
    timeout: 120,
    buildStep: 'Build unpublished Linux packages',
    buildRun:
      'pnpm exec electron-builder --config ../config/electron-builder-candidate.config.cjs --linux deb --x64 --publish never',
    stageStep: 'Stage exact Linux x64 allowlist',
    stageHash: '15d1841adb5582d78d3b8fce3cf5baffb63937fedf5eb91470e591069e949888',
    provenanceLabel: 'Linux x64'
  },
  'desktop-linux-arm64': {
    runner: 'ubuntu-24.04-arm',
    timeout: 120,
    buildStep: 'Build unpublished Linux packages',
    buildRun:
      'pnpm exec electron-builder --config ../config/electron-builder-candidate.config.cjs --linux deb --arm64 --publish never',
    stageStep: 'Stage exact Linux arm64 allowlist',
    stageHash: '98794e1db8ff12b47a45ac3fe58c86cbf5bdea19be82c198f7a306bd1e788908',
    provenanceLabel: 'Linux arm64'
  },
  'desktop-windows-x64': {
    runner: 'windows-2022',
    timeout: 120,
    buildStep: 'Build unpublished Windows installer',
    buildRun:
      'pnpm exec electron-builder --config ../config/electron-builder-candidate.config.cjs --win --x64 --publish never',
    stageStep: 'Stage exact unsigned Windows allowlist',
    stageHash: '3d0e9b40a86a60eeab1bb3643b01a2fc1544ff27706700dec77a7b63a5b70d87',
    provenanceLabel: 'Windows'
  },
  'desktop-macos': {
    runner: 'macos-26',
    timeout: 180,
    buildStep: 'Build unpublished macOS packages',
    buildRun:
      'pnpm run ensure:electron-runtime && pnpm exec electron-builder --config ../config/electron-builder-candidate.config.cjs --mac --x64 --arm64 --publish never',
    stageStep: 'Stage exact macOS allowlist',
    stageHash: '06b5941e03aba08edad4378e63ec48c9e56436e2bdc5e960b8dc008f7c9eeded',
    provenanceLabel: 'macOS'
  },
  'mobile-android': {
    runner: 'ubuntu-latest',
    timeout: 90,
    provenanceLabel: 'Android'
  },
  'mobile-ios-simulator': {
    runner: 'macos-26',
    timeout: 120,
    provenanceLabel: 'iOS simulator'
  }
}

const forbiddenSurfacePatterns = [
  /\$\{\{\s*secrets\./i,
  /\$\{\{[^}]*\bgithub\.token\b/i,
  /\b(?:ANDROID_KEYSTORE_PASSWORD|APPLE_API_KEY|APPLE_APP_SPECIFIC_PASSWORD|APPLE_ID|APPLE_TEAM_ID|ASC_API_KEY_P8|ASC_ISSUER_ID|ASC_KEY_ID|CSC_KEY_PASSWORD|CSC_LINK|CSC_NAME|EXPO_TOKEN|GH_TOKEN|GITHUB_TOKEN|GOOGLE_PLAY_SERVICE_ACCOUNT_JSON|IOS_DIST_CERT|IOS_DIST_CERT_P12|IOS_DIST_CERT_PASSWORD|KEYCHAIN_PASSWORD|MAC_CERTS|MAC_CERTS_PASSWORD|MATCH_PASSWORD|ORCA_POSTHOG_WRITE_KEY|SIGNPATH_API_TOKEN|WIN_CSC_LINK|WRITE_KEY)\b/i,
  /--publish\s+(?!never\b)\S+/i,
  /\b(?:git\s+(?:push|tag)|gh\s+(?:api|release)|docker\s+push|podman\s+push)\b/i,
  /\b(?:npm|pnpm|yarn|cargo)\s+publish\b/i,
  /\b(?:eas\s+(?:build|submit)|fastlane\b|codesign|jarsigner|notarytool|signtool|signpath)\b/i
]

function asObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`)
  }
  return value
}

function assertExact(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label} does not match the candidate policy`)
  }
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(asObject(value, label)).sort()
  const wanted = [...expected].sort()
  assertExact(actual, wanted, `${label} keys`)
}

function normalized(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value
}

function findStep(job, name) {
  const matches = job.steps.filter((step) => step.name === name)
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${name} step`)
  }
  return matches[0]
}

function validateWorkflowShape(workflow, policy) {
  assertExactKeys(workflow, ['name', 'on', 'permissions', 'concurrency', 'jobs'], 'workflow')
  assertExact(workflow.name, 'Candidate Artifacts', 'workflow name')
  assertExact(workflow.on, { workflow_dispatch: {} }, 'workflow triggers')
  assertExact(workflow.permissions, { contents: 'read' }, 'workflow permissions')
  assertExact(
    workflow.concurrency,
    { group: 'candidate-artifacts-${{ github.ref }}', 'cancel-in-progress': false },
    'workflow concurrency'
  )
  const jobs = asObject(workflow.jobs, 'jobs')
  assertExact(Object.keys(jobs).sort(), ['policy', ...Object.keys(buildJobs)].sort(), 'job set')
  assertExact(Object.keys(policy.platforms).sort(), Object.keys(buildJobs).sort(), 'platform set')
  return jobs
}

function validateJobShape(name, job, contract) {
  const isPolicy = name === 'policy'
  assertExactKeys(
    job,
    isPolicy
      ? ['runs-on', 'timeout-minutes', 'steps']
      : ['needs', 'runs-on', 'timeout-minutes', 'steps'],
    `job ${name}`
  )
  if (!isPolicy && job.needs !== 'policy') {
    throw new Error(`${name} must have needs: policy`)
  }
  assertExact(job['runs-on'], contract.runner, `${name} runner`)
  if (
    !Number.isInteger(job['timeout-minutes']) ||
    job['timeout-minutes'] < 1 ||
    job['timeout-minutes'] > 180 ||
    job['timeout-minutes'] !== contract.timeout
  ) {
    throw new Error(`${name} timeout-minutes must be the expected integer from 1 to 180`)
  }
  if (!Array.isArray(job.steps) || job.steps.length === 0) {
    throw new Error(`${name} must contain steps`)
  }
  for (const step of job.steps) {
    asObject(step, `${name} step`)
  }
}

function validateCheckouts(name, job, sourceRevision) {
  const checkouts = job.steps.filter((step) => step.uses === checkoutAction)
  if (checkouts.length !== 2 || job.steps[0] !== checkouts[0] || job.steps[1] !== checkouts[1]) {
    throw new Error(`${name} must begin with exactly two policy/source checkouts`)
  }
  assertExact(
    checkouts[0],
    {
      name: 'Checkout candidate policy',
      uses: checkoutAction,
      with: { ref: workflowRevision, 'persist-credentials': false }
    },
    `${name} policy checkout`
  )
  assertExact(
    checkouts[1],
    {
      name: 'Checkout pinned candidate source',
      uses: checkoutAction,
      with: { ref: sourceRevision, path: 'source', 'persist-credentials': false }
    },
    `${name} source checkout`
  )
}

function validateActions(name, job, platform) {
  const actionSteps = job.steps.filter((step) => step.uses !== undefined)
  for (const step of actionSteps) {
    if (!approvedActions.has(step.uses)) {
      throw new Error(`${name} uses an unapproved action: ${step.uses}`)
    }
  }
  const pnpmSteps = actionSteps.filter((step) => step.uses === pnpmAction)
  assertExact(
    pnpmSteps,
    [{ name: 'Setup pnpm', uses: pnpmAction, with: { run_install: false } }],
    `${name} pnpm action`
  )
  const nodeWith =
    name === 'policy'
      ? { 'node-version-file': 'package.json' }
      : platform.startsWith('desktop-')
        ? {
            'node-version-file': 'source/package.json',
            cache: 'pnpm',
            'cache-dependency-path': 'source/pnpm-lock.yaml'
          }
        : {
            'node-version': 24,
            cache: 'pnpm',
            'cache-dependency-path': 'source/mobile/pnpm-lock.yaml'
          }
  const nodeSteps = actionSteps.filter((step) => step.uses === nodeAction)
  assertExact(
    nodeSteps,
    [{ name: 'Setup Node.js', uses: nodeAction, with: nodeWith }],
    `${name} Node action`
  )
}

function validateProvenance(job, platform, label) {
  const artifactDirectory = `candidate-out/${platform}`
  for (const command of ['Write', 'Verify']) {
    const step = findStep(job, `${command} ${label} provenance`)
    assertExactKeys(step, ['name', 'run'], `${platform} ${command.toLowerCase()} provenance step`)
    const expected =
      `node config/scripts/candidate-artifact-provenance.mjs ${command.toLowerCase()} ` +
      `--platform ${platform} --source source --artifacts ${artifactDirectory} ` +
      `--workflow-revision "${workflowRevision}"`
    assertExact(
      normalized(step.run),
      expected,
      `${platform} ${command.toLowerCase()} provenance command`
    )
  }
}

function validateUpload(job, platform) {
  const uploads = job.steps.filter((step) => step.uses === uploadAction)
  assertExact(
    uploads,
    [
      {
        name: platform === 'desktop-macos' ? 'Upload macOS candidates' : findUploadName(platform),
        uses: uploadAction,
        with: {
          name: `orca-candidate-${platform}`,
          path: `candidate-out/${platform}`,
          'retention-days': 7,
          'if-no-files-found': 'error'
        }
      }
    ],
    `${platform} upload`
  )
}

function findUploadName(platform) {
  return {
    'desktop-linux-x64': 'Upload Linux x64 candidates',
    'desktop-linux-arm64': 'Upload Linux arm64 candidates',
    'desktop-windows-x64': 'Upload Windows candidate',
    'mobile-android': 'Upload Android candidate',
    'mobile-ios-simulator': 'Upload iOS simulator candidate'
  }[platform]
}

function validateDesktopCommands(job, contract) {
  const build = findStep(job, contract.buildStep)
  assertExact(normalized(build.run), contract.buildRun, `${contract.buildStep} command`)
  const stage = findStep(job, contract.stageStep)
  const stageHash = createHash('sha256').update(stage.run).digest('hex')
  assertExact(stageHash, contract.stageHash, `${contract.stageStep} update-metadata assertions`)
}

function validateSourceRevisionLocations(workflow, policy, jobs) {
  let occurrences = 0
  function visit(value) {
    if (typeof value === 'string') {
      occurrences += value.split(policy.sourceRevision).length - 1
    } else if (Array.isArray(value)) {
      value.forEach(visit)
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(visit)
    }
  }
  visit(workflow)
  if (occurrences !== Object.keys(jobs).length) {
    throw new Error('Source revision may appear only in the source checkout of each job')
  }
}

function validateSerializedSurface(workflow) {
  const serialized = JSON.stringify(workflow)
  for (const pattern of forbiddenSurfacePatterns) {
    if (pattern.test(serialized)) {
      throw new Error(
        `Candidate workflow contains forbidden credential or publishing surface: ${pattern}`
      )
    }
  }
}

export function validateCandidateWorkflow(workflow, policy) {
  validateCandidateArtifactPolicy(policy)
  const jobs = validateWorkflowShape(workflow, policy)
  validateSerializedSurface(workflow)
  for (const [name, jobValue] of Object.entries(jobs)) {
    const job = asObject(jobValue, `job ${name}`)
    const contract = name === 'policy' ? { runner: 'ubuntu-latest', timeout: 15 } : buildJobs[name]
    validateJobShape(name, job, contract)
    validateCheckouts(name, job, policy.sourceRevision)
    validateActions(name, job, name)
    if (name === 'policy') {
      if (job.steps.some((step) => step.uses === uploadAction)) {
        throw new Error('Policy job must not upload artifacts')
      }
      continue
    }
    validateProvenance(job, name, contract.provenanceLabel)
    validateUpload(job, name)
    if (name.startsWith('desktop-')) {
      validateDesktopCommands(job, contract)
    }
  }
  validateSourceRevisionLocations(workflow, policy, jobs)
  const digest = createHash('sha256').update(JSON.stringify(workflow)).digest('hex')
  assertExact(digest, expectedWorkflowDigest, 'canonical workflow digest')
}

export async function validateCandidateWorkflowFile(workflowPath, policyPath) {
  const workflow = parse(await readFile(workflowPath, 'utf8'))
  const policy = JSON.parse(await readFile(policyPath, 'utf8'))
  validateCandidateWorkflow(workflow, policy)
}

if (process.argv[1] === import.meta.filename) {
  const workflowPath = resolve(process.argv[2] ?? '.github/workflows/candidate-artifacts.yml')
  const policyPath = resolve(process.argv[3] ?? 'config/candidate-artifacts.json')
  await validateCandidateWorkflowFile(workflowPath, policyPath)
}
