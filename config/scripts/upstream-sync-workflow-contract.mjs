import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { parse } from 'yaml'

const WORKFLOW_PATH = '.github/workflows/daily-upstream-sync.yml'
const ACTION_PINS = new Set([
  'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
  'pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86',
  'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38'
])
const FORBIDDEN_TEXT = [
  /\bsecrets\s*\./i,
  /github\s*(?:\.token|\[['"]token['"]\])/i,
  /\bGITHUB_TOKEN\b/,
  /\bgit\s+push\b/i,
  /\bgh\s+(?:pr|issue|release)\b/i,
  /\b(?:kubectl|flux)\b/i,
  /\bdocker\s+push\b/i,
  /\b(?:ubuntu-latest|ubuntu-[0-9]|windows-[0-9]|macos-[0-9]|blacksmith)\b/i,
  /actions\/(?:upload-artifact|download-artifact|cache)@/i
]

function requireValue(condition, message, failures) {
  if (!condition) {
    failures.push(message)
  }
}

export function validateDailyUpstreamSyncWorkflow(source) {
  const failures = []
  const workflow = parse(source)
  const triggerNames = Object.keys(workflow.on ?? {}).sort()
  requireValue(
    JSON.stringify(triggerNames) === JSON.stringify(['schedule', 'workflow_dispatch']),
    'workflow triggers must be exactly schedule and workflow_dispatch',
    failures
  )
  requireValue(
    JSON.stringify(workflow.permissions) === JSON.stringify({ contents: 'read' }),
    'top-level permissions must be exactly contents: read',
    failures
  )
  requireValue(Array.isArray(workflow.on?.schedule), 'workflow must have a schedule', failures)
  const jobs = Object.values(workflow.jobs ?? {})
  requireValue(jobs.length === 1, 'workflow must contain exactly one job', failures)
  const job = jobs[0] ?? {}
  requireValue(job['runs-on'] === 'orca-source-ci', 'job must use orca-source-ci', failures)
  requireValue(job.permissions === undefined, 'job must not override permissions', failures)
  requireValue(
    job['continue-on-error'] === undefined,
    'job must not neutralize terminal failures',
    failures
  )
  const steps = job.steps ?? []
  requireValue(
    steps.filter((step) => step.uses).every((step) => ACTION_PINS.has(step.uses)),
    'workflow actions must use approved 40-hex commit pins',
    failures
  )
  const checkoutSteps = steps.filter((step) => step.uses?.startsWith('actions/checkout@'))
  requireValue(checkoutSteps.length === 1, 'workflow must use one pinned checkout action', failures)
  const checkout = checkoutSteps[0]?.with ?? {}
  requireValue(checkout.ref === '${{ github.sha }}', 'checkout ref must be github.sha', failures)
  requireValue(checkout['fetch-depth'] === 0, 'checkout must fetch complete history', failures)
  requireValue(
    checkout['persist-credentials'] === false,
    'checkout must not persist credentials',
    failures
  )
  requireValue(checkout.token === '', 'checkout token must be explicitly empty', failures)
  const node = steps.find((step) => step.uses?.startsWith('actions/setup-node@'))
  requireValue(
    JSON.stringify(node?.with) === JSON.stringify({ 'node-version-file': 'package.json' }),
    'setup-node must not use GitHub dependency caching',
    failures
  )
  const simulation = steps.find((step) => step.id === 'simulation')
  requireValue(
    simulation?.['continue-on-error'] === true,
    'simulation must preserve reports',
    failures
  )
  requireValue(
    simulation?.run?.includes('--downstream-ref "${{ github.sha }}"'),
    'downstream SHA is not explicit',
    failures
  )
  requireValue(
    simulation?.run?.includes('--upstream-url https://github.com/stablyai/orca.git'),
    'official upstream URL is not fixed',
    failures
  )
  requireValue(
    simulation?.run?.includes('--upstream-ref refs/heads/main'),
    'official upstream ref is not explicit',
    failures
  )
  const retention = steps.find((step) => step.name === 'Retain immutable readiness report in MinIO')
  requireValue(
    retention?.if === 'always()',
    'readiness report must be retained on failure',
    failures
  )
  requireValue(
    retention?.['continue-on-error'] === undefined,
    'MinIO retention failures must remain fatal',
    failures
  )
  requireValue(
    retention?.run?.replace(/\s+/g, ' ').trim() ===
      'node config/scripts/minio-artifact-retention.mjs --prefix upstream-sync-readiness ' +
        '--source-sha "${{ github.sha }}" ' +
        '--workflow-file .github/workflows/daily-upstream-sync.yml ' +
        '--run-id "${{ github.run_id }}" --run-attempt "${{ github.run_attempt }}" ' +
        '--directory artifacts/upstream-sync',
    'readiness report must use the exact immutable MinIO retention command',
    failures
  )
  const retentionIndex = steps.indexOf(retention)
  const terminalGate = steps.at(-1)
  requireValue(
    retentionIndex === steps.length - 2,
    'MinIO retention must be immediately before the terminal failure gate',
    failures
  )
  requireValue(
    terminalGate?.name === 'Fail after preserving a non-mergeable report' &&
      terminalGate?.if === "always() && steps.simulation.outcome != 'success'" &&
      terminalGate?.run === 'exit 1' &&
      terminalGate?.['continue-on-error'] === undefined,
    'workflow must end with the exact non-success failure gate',
    failures
  )
  for (const pattern of FORBIDDEN_TEXT) {
    requireValue(!pattern.test(source), `forbidden workflow capability: ${pattern}`, failures)
  }
  const tokenMappings = [...source.matchAll(/^\s*token:\s*(.*)$/gm)].map((match) => match[1].trim())
  requireValue(
    tokenMappings.length === 1 && tokenMappings[0] === "''",
    'only one explicitly empty token mapping is allowed',
    failures
  )
  return failures
}

export function checkDailyUpstreamSyncWorkflow(file = WORKFLOW_PATH) {
  const failures = validateDailyUpstreamSyncWorkflow(readFileSync(file, 'utf8'))
  if (failures.length > 0) {
    throw new Error(failures.join('\n'))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    checkDailyUpstreamSyncWorkflow()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
