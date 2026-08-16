import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { validateDailyUpstreamSyncWorkflow } from './upstream-sync-workflow-contract.mjs'

const workflowPath = '.github/workflows/daily-upstream-sync.yml'
const runbookPath = 'docs/reference/downstream-upstream-sync.md'

describe('daily upstream sync workflow', () => {
  it('keeps source-fork Actions permanently disabled until controlled relocation', () => {
    const runbook = readFileSync(runbookPath, 'utf8')
    expect(runbook).toContain(
      'The `BlackCatCXIII/orca` repository Actions must remain globally disabled permanently.'
    )
    expect(runbook).toContain(
      'never temporarily enable repository Actions to make GitHub register it'
    )
    expect(runbook).toContain(
      'requires relocating the exact reviewed workflow and contracts to\n' +
        '   the already-controlled `orca-deployment` repository'
    )
  })
  it('stays read-only, credential-free, exact-SHA, and bounded', () => {
    const source = readFileSync(workflowPath, 'utf8')
    expect(validateDailyUpstreamSyncWorkflow(source)).toEqual([])
  })

  it('rejects permission and credential drift', () => {
    const source = readFileSync(workflowPath, 'utf8')
    const writePermission = source.replace('contents: read', 'contents: write')
    const credential = source.replace("token: ''", 'token: ${{ github.token }}')
    expect(validateDailyUpstreamSyncWorkflow(writePermission)).toContain(
      'top-level permissions must be exactly contents: read'
    )
    expect(validateDailyUpstreamSyncWorkflow(credential).join('\n')).toMatch(
      /checkout token must be explicitly empty|forbidden workflow capability/
    )
  })

  it('rejects moving checkout refs and mutable retention keys', () => {
    const source = readFileSync(workflowPath, 'utf8')
    expect(
      validateDailyUpstreamSyncWorkflow(source.replace('ref: ${{ github.sha }}', 'ref: main'))
    ).toContain('checkout ref must be github.sha')
    expect(
      validateDailyUpstreamSyncWorkflow(
        source.replace('--prefix upstream-sync-readiness', '--prefix latest')
      )
    ).toContain('readiness report must use the exact immutable MinIO retention command')
  })

  it('rejects write-oriented triggers and unreviewed actions', () => {
    const source = readFileSync(workflowPath, 'utf8')
    expect(
      validateDailyUpstreamSyncWorkflow(source.replace('workflow_dispatch:', 'push:'))
    ).toContain('workflow triggers must be exactly schedule and workflow_dispatch')
    expect(
      validateDailyUpstreamSyncWorkflow(
        source.replace(
          'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38',
          'third-party/publish@v1'
        )
      )
    ).toContain('workflow actions must use approved 40-hex commit pins')
  })

  it('rejects mutable major-version action tags', () => {
    const source = readFileSync(workflowPath, 'utf8')
    const mutableCheckout = source.replace(
      'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
      'actions/checkout@v6'
    )
    expect(validateDailyUpstreamSyncWorkflow(mutableCheckout)).toContain(
      'workflow actions must use approved 40-hex commit pins'
    )
  })

  it('rejects hosted runners, GitHub artifacts, and GitHub dependency caches', () => {
    const source = readFileSync(workflowPath, 'utf8')
    expect(
      validateDailyUpstreamSyncWorkflow(source.replace('orca-source-ci', 'ubuntu-latest')).join(
        '\n'
      )
    ).toMatch(/job must use orca-source-ci|forbidden workflow capability/)
    expect(
      validateDailyUpstreamSyncWorkflow(
        source.replace(
          '      - name: Install script-free dependencies',
          '      - uses: actions/upload-artifact@1111111111111111111111111111111111111111\n\n' +
            '      - name: Install script-free dependencies'
        )
      ).join('\n')
    ).toMatch(/approved 40-hex commit pins|forbidden workflow capability/)
    expect(
      validateDailyUpstreamSyncWorkflow(
        source.replace(
          '          package-manager-cache: false',
          '          package-manager-cache: false\n          cache: pnpm'
        )
      )
    ).toContain('setup-node must not use GitHub dependency caching')
    expect(
      validateDailyUpstreamSyncWorkflow(
        source.replace('          package-manager-cache: false\n', '')
      )
    ).toContain('setup-node must not use GitHub dependency caching')
  })

  it('requires the exact terminal failure gate immediately after MinIO retention', () => {
    const source = readFileSync(workflowPath, 'utf8')
    const neutralized = source.replace('run: exit 1', 'run: exit 0')
    const deleted = source.replace(
      /\n      - name: Fail after preserving a non-mergeable report[\s\S]*$/,
      ''
    )
    const insertedAfterUpload = source.replace(
      '      - name: Fail after preserving a non-mergeable report',
      '      - name: Extra terminal step\n        run: echo bypass\n\n' +
        '      - name: Fail after preserving a non-mergeable report'
    )
    const neutralizedFailure = source.replace(
      '        run: exit 1',
      '        continue-on-error: true\n        run: exit 1'
    )
    const neutralizedCondition = source.replace(
      "if: always() && steps.simulation.outcome != 'success'",
      'if: always()'
    )
    for (const mutation of [
      neutralized,
      deleted,
      insertedAfterUpload,
      neutralizedFailure,
      neutralizedCondition
    ]) {
      expect(validateDailyUpstreamSyncWorkflow(mutation).join('\n')).toMatch(
        /MinIO retention must be immediately before|exact non-success failure gate/
      )
    }
  })
})
