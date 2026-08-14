import { describe, expect, it } from 'vitest'
import { parseOperatorCatalogJson } from './operator-catalog-strict-json'

describe('operator catalog strict JSON nesting', () => {
  it('accepts exactly sixteen nested containers', () => {
    const source = `${'['.repeat(16)}null${']'.repeat(16)}`

    expect(parseOperatorCatalogJson(source)).toBeDefined()
  })

  it('rejects the seventeenth container even when it is empty', () => {
    const source = `${'['.repeat(16)}[]${']'.repeat(16)}`

    expect(() => parseOperatorCatalogJson(source)).toThrow(/nesting limit/)
  })
})
