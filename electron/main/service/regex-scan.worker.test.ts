// @vitest-environment node
import { describe, it, expect } from 'vitest'
import type { RegexScanRequest, RegexScanResponse } from './regex-scan.worker'
import { handleRegexScanRequest } from './regex-scan.worker'

const base: RegexScanRequest = {
  query: 'x',
  opts: { matchCase: false, regexp: true, wholeWord: false },
  max: 50,
  contents: ['x', 'y'],
}

// The handler running INSIDE the thread is what this file covers, so the isolation layer around
// it can stay thin.
describe('handleRegexScanRequest (ADR-0023 D37)', () => {
  it('scans every body in order, honouring the display cap', () => {
    const body = Array.from({ length: 60 }, () => 'ab').join(' ')
    const res = handleRegexScanRequest({ ...base, query: '[ab]+', contents: [body, 'nope'] })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.results[0].total).toBe(60)
    expect(res.results[0].matches).toHaveLength(50)
    expect(res.results[0].capped).toBe(true)
    expect(res.results[1]).toEqual({ matches: [], total: 0, capped: false })
  })

  it('returns an empty scan for an empty body without touching the matcher', () => {
    const res = handleRegexScanRequest({ ...base, contents: [''] })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.results[0]).toEqual({ matches: [], total: 0, capped: false })
  })

  it('fails the batch when the query does not compile', () => {
    const res: RegexScanResponse = handleRegexScanRequest({ ...base, query: '(unclosed' })
    expect(res.ok).toBe(false)
  })
})
