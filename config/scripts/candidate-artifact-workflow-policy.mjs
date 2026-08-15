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
const approvedActions = new Set([checkoutAction, pnpmAction, nodeAction])
const expectedWorkflowDigest = 'e9ede3191d3b83054ec32fc74c7401eeb708c6e1ebaa74916646eedd020c6a9f'
const expectedPlatforms = [
  'desktop-linux-arm64',
  'desktop-linux-x64',
  'desktop-macos',
  'desktop-windows-x64',
  'mobile-android',
  'mobile-ios-simulator'
]
const linuxContract = {
  runner: 'orca-source-ci',
  timeout: 120,
  buildStep: 'Build unpublished Linux packages',
  buildRun:
    'pnpm exec electron-builder --config ../config/electron-builder-candidate.config.cjs --linux deb --x64 --publish never',
  stageStep: 'Stage exact Linux x64 allowlist',
  stageHash: '15d1841adb5582d78d3b8fce3cf5baffb63937fedf5eb91470e591069e949888',
  provenanceLabel: 'Linux x64'
}

const forbiddenSurfacePatterns = [
  /\$\{\{\s*secrets\./i,
  /\$\{\{[^}]*\bgithub\.token\b/i,
  /\b(?:GITHUB_TOKEN|GH_TOKEN)\b/i,
  /\b(?:ubuntu-latest|ubuntu-[0-9]|windows-[0-9]|macos-[0-9]|blacksmith)\b/i,
  /actions\/(?:upload-artifact|download-artifact|cache)@/i,
  /setup-node[^}]*["']?cache["']?\s*:/i,
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
  assertExact(Object.keys(asObject(value, label)).sort(), [...expected].sort(), `${label} keys`)
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
  assertExact(Object.keys(jobs).sort(), ['desktop-linux-x64', 'policy'], 'job set')
  assertExact(
    Object.keys(policy.platforms).sort(),
    expectedPlatforms,
    'qualified platform policy set'
  )
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
  assertExact(job['timeout-minutes'], contract.timeout, `${name} timeout`)
  if (!Array.isArray(job.steps) || job.steps.length === 0) {
    throw new Error(`${name} must contain steps`)
  }
  job.steps.forEach((step) => asObject(step, `${name} step`))
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

function validateActions(name, job) {
  const actionSteps = job.steps.filter((step) => step.uses !== undefined)
  for (const step of actionSteps) {
    if (!approvedActions.has(step.uses)) {
      throw new Error(`${name} uses an unapproved action: ${step.uses}`)
    }
  }
  assertExact(
    actionSteps.filter((step) => step.uses === pnpmAction),
    [{ name: 'Setup pnpm', uses: pnpmAction, with: { run_install: false } }],
    `${name} pnpm action`
  )
  assertExact(
    actionSteps.filter((step) => step.uses === nodeAction),
    [
      {
        name: 'Setup Node.js',
        uses: nodeAction,
        with: { 'node-version-file': name === 'policy' ? 'package.json' : 'source/package.json' }
      }
    ],
    `${name} Node action`
  )
}

function validateProvenance(job) {
  const artifactDirectory = 'candidate-out/desktop-linux-x64'
  for (const command of ['Write', 'Verify']) {
    const step = findStep(job, `${command} Linux x64 provenance`)
    assertExactKeys(step, ['name', 'run'], `${command.toLowerCase()} provenance step`)
    assertExact(
      normalized(step.run),
      `node config/scripts/candidate-artifact-provenance.mjs ${command.toLowerCase()} ` +
        `--platform desktop-linux-x64 --source source --artifacts ${artifactDirectory} ` +
        `--workflow-revision "${workflowRevision}"`,
      `${command.toLowerCase()} provenance command`
    )
  }
}

function validateRetention(job) {
  const step = findStep(job, 'Retain immutable Linux x64 candidates in MinIO')
  assertExactKeys(step, ['name', 'run'], 'MinIO retention step')
  assertExact(
    normalized(step.run),
    'node config/scripts/minio-artifact-retention.mjs --prefix candidate-artifacts ' +
      '--source-sha "$(git -C source rev-parse HEAD)" ' +
      '--workflow-file .github/workflows/candidate-artifacts.yml ' +
      '--run-id "${{ github.run_id }}" --run-attempt "${{ github.run_attempt }}" ' +
      '--directory candidate-out/desktop-linux-x64',
    'MinIO retention command'
  )
}

function validateDesktopCommands(job) {
  const build = findStep(job, linuxContract.buildStep)
  assertExact(normalized(build.run), linuxContract.buildRun, `${linuxContract.buildStep} command`)
  const stage = findStep(job, linuxContract.stageStep)
  const stageHash = createHash('sha256').update(stage.run).digest('hex')
  assertExact(stageHash, linuxContract.stageHash, `${linuxContract.stageStep} assertions`)
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
        `Candidate workflow contains forbidden execution or storage surface: ${pattern}`
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
    const contract = name === 'policy' ? { runner: 'orca-source-ci', timeout: 15 } : linuxContract
    validateJobShape(name, job, contract)
    validateCheckouts(name, job, policy.sourceRevision)
    validateActions(name, job)
    if (name === 'desktop-linux-x64') {
      validateProvenance(job)
      validateRetention(job)
      validateDesktopCommands(job)
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
