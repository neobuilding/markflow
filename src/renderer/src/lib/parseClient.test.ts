import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock comlink so we don't need a real Worker. We capture the wrapped remote
// so tests can drive both the worker-fast path and the worker-failed fallback.
const mockRemote = {
  parse: vi.fn(),
}
vi.mock('comlink', () => ({
  wrap: () => mockRemote,
  expose: () => {},
}))

// Mock the Worker constructor used by parseClient (it passes a module URL).
class FakeWorker {
  constructor(_url: unknown, _opts?: unknown) {}
}
vi.stubGlobal('Worker', FakeWorker)

import { parseMarkdown, warmupParseWorker } from './parseClient'
import * as pipeline from './markdownPipeline'

describe('parseClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses via the worker when available', async () => {
    const result = { html: '<p>hi</p>', mermaid: [] }
    mockRemote.parse.mockResolvedValue(result)
    const out = await parseMarkdown('# hi', null)
    expect(mockRemote.parse).toHaveBeenCalledWith('# hi', null)
    expect(out).toEqual(result)
  })

  it('falls back to the main thread when the worker throws', async () => {
    mockRemote.parse.mockRejectedValueOnce(new Error('worker boom'))
    const out = await parseMarkdown('# hello', 'doc-1')
    expect(mockRemote.parse).toHaveBeenCalledTimes(1)
    expect(out.html).toContain('hello')
  })

  it('returns an error HTML string when both worker and main thread fail', async () => {
    mockRemote.parse.mockRejectedValueOnce(new Error('worker boom'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Force the main-thread fallback (render) to also fail.
    const renderSpy = vi.spyOn(pipeline, 'render').mockImplementation(() => {
      throw new Error('main boom')
    })
    const out = await parseMarkdown('# x', null)
    expect(out.html).toContain('Error rendering preview')
    expect(out.mermaid).toEqual([])
    renderSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('warmupParseWorker triggers a parse without throwing if the worker fails', () => {
    mockRemote.parse.mockRejectedValueOnce(new Error('warmup boom'))
    expect(() => warmupParseWorker()).not.toThrow()
  })
})
