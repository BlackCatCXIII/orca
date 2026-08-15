import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parse } from 'yaml'
import { expect, test } from 'vitest'
import {
  verifyCandidateProvenance,
  writeCandidateProvenance
} from './candidate-artifact-provenance.mjs'
import { validateCandidateWorkflow } from './candidate-artifact-workflow-policy.mjs'

const workflowPath = resolve('.github/workflows/candidate-artifacts.yml')
const policyPath = resolve('config/candidate-artifacts.json')
const supportRevision = 'f910c801aac823bb1b0768e79d1b3c865db295ac'
const require = createRequire(import.meta.url)

async function fixture() {
  return {
    workflow: parse(await readFile(workflowPath, 'utf8')),
    policy: JSON.parse(await readFile(policyPath, 'utf8'))
  }
}

function git(directory, arguments_) {
  return execFileSync('git', ['-C', directory, ...arguments_], { encoding: 'utf8' }).trim()
}

async function createHermeticSource(directory, policy) {
  const sourceRoot = join(directory, 'source')
  await mkdir(sourceRoot)
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
    'candidate provenance fixture'
  ])
  const fixturePolicy = { ...policy, sourceRevision: git(sourceRoot, ['rev-parse', 'HEAD']) }
  const fixturePolicyPath = join(directory, 'candidate-artifacts.json')
  await writeFile(fixturePolicyPath, JSON.stringify(fixturePolicy))
  return { fixturePolicyPath, sourceRoot }
}

test('accepts the candidate workflow', async () => {
  const { workflow, policy } = await fixture()
  expect(() => validateCandidateWorkflow(workflow, policy)).not.toThrow()
})

test('keeps candidate runtime source distinct from the integrated support contract', async () => {
  const { policy } = await fixture()
  const documentation = await readFile(resolve('.github/CANDIDATE_ARTIFACTS.md'), 'utf8')

  expect(policy.sourceRevision).toBe('cc7d1abaef9a1d89675d985b5ff6e1574b998a18')
  expect(policy.sourceRevision).not.toBe(supportRevision)
  expect(documentation).toContain(policy.sourceRevision)
  expect(documentation).toContain(supportRevision)
})

test('keeps candidate execution disabled in the source fork until controlled relocation', async () => {
  const documentation = await readFile(resolve('.github/CANDIDATE_ARTIFACTS.md'), 'utf8')
  expect(documentation).toContain(
    'It must not be enabled or executed in the `BlackCatCXIII/orca` source\n' +
      'fork: repository Actions remain globally disabled there permanently.'
  )
  expect(documentation).toContain(
    'Execution requires relocating\n' +
      'the reviewed workflow and contracts to the already-controlled `orca-deployment` repository'
  )
})

/** @type {Array<[string, (workflow: any) => void]>} */
const adversarialCases = [
  ['push trigger', (workflow) => (workflow.on.push = {})],
  ['pull request trigger', (workflow) => (workflow.on.pull_request = {})],
  ['schedule trigger', (workflow) => (workflow.on.schedule = [{ cron: '0 * * * *' }])],
  [
    'mutable action',
    (workflow) =>
      (workflow.jobs.policy.steps.find((step) => step.uses).uses = 'actions/checkout@v4')
  ],
  ['broad permissions', (workflow) => (workflow.permissions.contents = 'write')],
  [
    'publishing command',
    (workflow) => workflow.jobs.policy.steps.push({ run: 'git push origin main' })
  ],
  [
    'signing command',
    (workflow) => workflow.jobs.policy.steps.push({ run: 'codesign --sign identity candidate.app' })
  ],
  [
    'secret in step env',
    (workflow) =>
      workflow.jobs.policy.steps.push({ run: 'true', env: { TOKEN: '${{ secrets.TOKEN }}' } })
  ],
  [
    'secret in step with',
    (workflow) =>
      (workflow.jobs.policy.steps.find((step) => step.uses?.includes('setup-node')).with.token =
        '${{ secrets.TOKEN }}')
  ],
  [
    'secret in job env',
    (workflow) => (workflow.jobs['desktop-linux-x64'].env = { TOKEN: '${{ secrets.TOKEN }}' })
  ],
  [
    'github token in step if',
    (workflow) =>
      (workflow.jobs.policy.steps.find((step) => step.run).if = '${{ github.token != null }}')
  ],
  [
    'job-level reusable workflow',
    (workflow) =>
      (workflow.jobs['desktop-linux-x64'].uses =
        'owner/repository/.github/workflows/build.yml@1111111111111111111111111111111111111111')
  ],
  [
    'unapproved immutable action',
    (workflow) =>
      (workflow.jobs.policy.steps.find((step) => step.uses?.includes('setup-node')).uses =
        'evil/action@1111111111111111111111111111111111111111')
  ],
  [
    'local action',
    (workflow) =>
      (workflow.jobs.policy.steps.find((step) => step.uses?.includes('setup-node')).uses =
        './evil-action')
  ],
  ['missing needs policy', (workflow) => delete workflow.jobs['desktop-linux-x64'].needs],
  [
    'wrong source checkout ref',
    (workflow) =>
      (workflow.jobs['desktop-linux-x64'].steps[1].with.ref =
        '1111111111111111111111111111111111111111')
  ],
  [
    'missing source checkout ref',
    (workflow) => delete workflow.jobs['desktop-linux-x64'].steps[1].with.ref
  ],
  [
    'wrong source checkout path',
    (workflow) => (workflow.jobs['desktop-linux-x64'].steps[1].with.path = 'other-source')
  ],
  [
    'missing source checkout path',
    (workflow) => delete workflow.jobs['desktop-linux-x64'].steps[1].with.path
  ],
  [
    'source revision elsewhere',
    (workflow) => {
      const step = workflow.jobs.policy.steps.find((candidate) => candidate.run)
      step.run += '\necho cc7d1abaef9a1d89675d985b5ff6e1574b998a18'
    }
  ],
  [
    'wrong workflow revision expression',
    (workflow) => {
      const step = workflow.jobs['desktop-linux-x64'].steps.find((candidate) =>
        candidate.name.startsWith('Write Linux x64 provenance')
      )
      step.run = step.run.replace('github.workflow_sha', 'github.sha')
    }
  ],
  ['zero timeout', (workflow) => (workflow.jobs['desktop-linux-x64']['timeout-minutes'] = 0)],
  ['negative timeout', (workflow) => (workflow.jobs['desktop-linux-x64']['timeout-minutes'] = -1)],
  [
    'removed update metadata assertion',
    (workflow) => {
      const step = workflow.jobs['desktop-linux-x64'].steps.find((candidate) =>
        candidate.name.startsWith('Stage exact Linux x64')
      )
      step.run = step.run.replace('metadata=(source/dist/latest*.yml source/dist/*.blockmap)\n', '')
    }
  ],
  [
    'extra job',
    (workflow) => (workflow.jobs.unexpected = structuredClone(workflow.jobs['desktop-linux-x64']))
  ],
  [
    'GitHub-hosted runner',
    (workflow) => (workflow.jobs['desktop-linux-x64']['runs-on'] = 'ubuntu-latest')
  ],
  [
    'GitHub artifact storage',
    (workflow) =>
      workflow.jobs['desktop-linux-x64'].steps.push({
        uses: 'actions/upload-artifact@1111111111111111111111111111111111111111'
      })
  ],
  [
    'GitHub action cache',
    (workflow) =>
      workflow.jobs.policy.steps.push({
        uses: 'actions/cache@1111111111111111111111111111111111111111'
      })
  ],
  [
    'setup-node cache',
    (workflow) => {
      workflow.jobs['desktop-linux-x64'].steps.find((step) =>
        step.uses?.startsWith('actions/setup-node@')
      ).with.cache = 'pnpm'
    }
  ],
  [
    'implicit setup-node package-manager cache',
    (workflow) => {
      delete workflow.jobs.policy.steps.find((step) => step.uses?.startsWith('actions/setup-node@'))
        .with['package-manager-cache']
    }
  ],
  [
    'mutable MinIO prefix',
    (workflow) => {
      const retention = workflow.jobs['desktop-linux-x64'].steps.find((step) =>
        step.name?.startsWith('Retain immutable')
      )
      retention.run = retention.run.replace('--prefix candidate-artifacts', '--prefix latest')
    }
  ],
  [
    'missing MinIO readback retention',
    (workflow) =>
      (workflow.jobs['desktop-linux-x64'].steps = workflow.jobs['desktop-linux-x64'].steps.filter(
        (step) => !step.name?.startsWith('Retain immutable')
      ))
  ],
  [
    'missing provenance verification',
    (workflow) =>
      (workflow.jobs['desktop-linux-x64'].steps = workflow.jobs['desktop-linux-x64'].steps.filter(
        (step) => !step.run?.includes('candidate-artifact-provenance.mjs verify')
      ))
  ]
]

test('disables Electron Builder publishing, signing, and update metadata', () => {
  const candidateConfig = require('../electron-builder-candidate.config.cjs')
  expect(candidateConfig.publish).toBeNull()
  expect(candidateConfig.forceCodeSigning).toBe(false)
  expect(candidateConfig.generateUpdatesFilesForAllChannels).toBe(false)
  expect(candidateConfig.nsis.differentialPackage).toBe(false)
  expect(candidateConfig.mac.hardenedRuntime).toBe(false)
  expect(candidateConfig.mac.notarize).toBe(false)
  expect(candidateConfig.mac.target).toEqual([
    {
      target: 'dmg',
      arch: ['x64', 'arm64']
    }
  ])
})

test('keeps unsupported build platforms explicitly absent from execution', async () => {
  const { workflow, policy } = await fixture()
  expect(Object.keys(workflow.jobs).sort()).toEqual(['desktop-linux-x64', 'policy'])
  expect(Object.keys(policy.platforms).sort()).toEqual([
    'desktop-linux-arm64',
    'desktop-linux-x64',
    'desktop-macos',
    'desktop-windows-x64',
    'mobile-android',
    'mobile-ios-simulator'
  ])
})

test('pins every workflow source checkout to the policy revision', async () => {
  const { workflow, policy } = await fixture()
  for (const job of Object.values(workflow.jobs)) {
    expect(job.steps[0].with).toEqual({
      ref: '${{ github.workflow_sha }}',
      'persist-credentials': false
    })
    expect(job.steps[1].with).toEqual({
      ref: policy.sourceRevision,
      path: 'source',
      'persist-credentials': false
    })
  }
})

for (const [name, mutate] of adversarialCases) {
  test(`rejects ${name}`, async () => {
    const { workflow, policy } = await fixture()
    mutate(workflow)
    expect(() => validateCandidateWorkflow(workflow, policy)).toThrow()
  })
}

test('writes deterministic provenance and fails closed on tampering', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-candidate-'))
  try {
    const { policy } = await fixture()
    const { fixturePolicyPath, sourceRoot } = await createHermeticSource(directory, policy)
    const artifactDirectory = join(directory, 'artifacts')
    await mkdir(artifactDirectory)
    await writeFile(join(artifactDirectory, 'orca-desktop-windows-x64.exe'), 'candidate-bytes')
    const request = {
      platform: 'desktop-windows-x64',
      sourceRoot,
      artifactDirectory,
      workflowRevision: '1111111111111111111111111111111111111111',
      policyPath: fixturePolicyPath
    }
    const first = await writeCandidateProvenance(request)
    const firstBytes = await readFile(join(artifactDirectory, 'provenance.json'), 'utf8')
    await writeCandidateProvenance(request)
    expect(await readFile(join(artifactDirectory, 'provenance.json'), 'utf8')).toBe(firstBytes)
    expect(first.sourceRevision).toBe(git(sourceRoot, ['rev-parse', 'HEAD']))

    await expect(
      verifyCandidateProvenance({
        ...request,
        workflowRevision: '2222222222222222222222222222222222222222'
      })
    ).rejects.toThrow(/identity fields/)

    await writeFile(join(artifactDirectory, 'unexpected.txt'), 'unexpected')
    await expect(verifyCandidateProvenance(request)).rejects.toThrow(/allowlist mismatch/)
    await rm(join(artifactDirectory, 'unexpected.txt'))

    const manifest = JSON.parse(await readFile(join(artifactDirectory, 'provenance.json'), 'utf8'))
    delete manifest.sourceRevision
    await writeFile(join(artifactDirectory, 'provenance.json'), JSON.stringify(manifest))
    await expect(verifyCandidateProvenance(request)).rejects.toThrow(/provenance fields/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects the current checkout when it is not the pinned source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-candidate-current-'))
  try {
    await writeFile(join(directory, 'orca-desktop-windows-x64.exe'), 'candidate-bytes')
    await expect(
      writeCandidateProvenance({
        platform: 'desktop-windows-x64',
        sourceRoot: resolve('.'),
        artifactDirectory: directory,
        workflowRevision: '1111111111111111111111111111111111111111',
        policyPath
      })
    ).rejects.toThrow(/Expected source revision cc7d1abaef9a1d89675d985b5ff6e1574b998a18/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
