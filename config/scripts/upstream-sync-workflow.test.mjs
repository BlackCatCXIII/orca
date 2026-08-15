import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { validateDailyUpstreamSyncWorkflow } from './upstream-sync-workflow-contract.mjs'

const workflowPath = '.github/workflows/daily-upstream-sync.yml'

describe('daily upstream sync workflow', () => {
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

  it('rejects moving checkout refs and unbounded artifacts', () => {
    const source = readFileSync(workflowPath, 'utf8')
    expect(
      validateDailyUpstreamSyncWorkflow(source.replace('ref: ${{ github.sha }}', 'ref: main'))
    ).toContain('checkout ref must be github.sha')
    expect(
      validateDailyUpstreamSyncWorkflow(source.replace('retention-days: 14', 'retention-days: 90'))
    ).toContain('report retention must be an integer no greater than 14 days')
  })

  it('rejects write-oriented triggers and unreviewed actions', () => {
    const source = readFileSync(workflowPath, 'utf8')
    expect(
      validateDailyUpstreamSyncWorkflow(source.replace('workflow_dispatch:', 'push:'))
    ).toContain('workflow triggers must be exactly schedule and workflow_dispatch')
    expect(
      validateDailyUpstreamSyncWorkflow(
        source.replace(
          'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
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
})
