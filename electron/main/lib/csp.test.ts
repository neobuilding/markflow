import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const onHeadersReceived = vi.fn()
  return {
    onHeadersReceived,
    callback: vi.fn(),
  }
})

vi.mock('electron', () => ({
  session: {
    defaultSession: {
      webRequest: {
        onHeadersReceived: h.onHeadersReceived,
      },
    },
  },
}))

async function loadCsp() {
  return import('./csp')
}

describe('csp — setupCSP', () => {
  beforeEach(() => {
    h.onHeadersReceived.mockClear()
    h.callback.mockClear()
  })

  it('registers a single onHeadersReceived handler', async () => {
    const { setupCSP } = await loadCsp()
    setupCSP('http://localhost:5174')
    expect(h.onHeadersReceived).toHaveBeenCalledTimes(1)
  })

  it('applies a permissive policy in dev (with Vite URL), including ws origins and 127.0.0.1', async () => {
    const { setupCSP } = await loadCsp()
    setupCSP('http://localhost:5174')
    const handler = h.onHeadersReceived.mock.calls[0]![0]

    const details = {
      url: 'http://localhost:5174/index.html',
      responseHeaders: { 'X-Test': ['1'] },
    }
    handler(details, h.callback)

    expect(h.callback).toHaveBeenCalledTimes(1)
    const out = h.callback.mock.calls[0]![0]
    const csp = out.responseHeaders!['Content-Security-Policy'] as string[]
    expect(csp).toHaveLength(1)
    const policy = csp[0]!
    expect(policy).toContain("default-src 'self' http://localhost:5174")
    expect(policy).toContain(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:5174",
    )
    expect(policy).toContain('ws://localhost:5174')
    expect(policy).toContain('ws://127.0.0.1:5174')
    expect(policy).toContain('appdoc:')
    // The original headers are preserved.
    expect(out.responseHeaders!['X-Test']).toEqual(['1'])
  })

  it('uses a strict self-only policy in production (no dev URL)', async () => {
    const { setupCSP } = await loadCsp()
    setupCSP('')
    const handler = h.onHeadersReceived.mock.calls[0]![0]

    const details = { url: 'https://example.com/page', responseHeaders: { 'X-Test': ['1'] } }
    handler(details, h.callback)

    const policy = (
      h.callback.mock.calls[0]![0].responseHeaders!['Content-Security-Policy'] as string[]
    )[0]!
    expect(policy).toContain("default-src 'self'")
    // Production locks down scripts (no unsafe-inline / unsafe-eval), but styles
    // still allow inline (required for some UI frameworks).
    expect(policy).toContain("script-src 'self'")
    expect(policy).not.toContain("'unsafe-eval'")
    expect(policy).not.toContain('http://localhost')
  })

  it('falls back to the default origin when the dev URL is malformed', async () => {
    const { setupCSP } = await loadCsp()
    setupCSP('not-a-valid-url')
    const handler = h.onHeadersReceived.mock.calls[0]![0]

    const details = { url: 'http://localhost:5174/index.html', responseHeaders: {} }
    handler(details, h.callback)
    const policy = (
      h.callback.mock.calls[0]![0].responseHeaders!['Content-Security-Policy'] as string[]
    )[0]!
    // Default origin is http://localhost:5174 (kept because URL parsing threw).
    expect(policy).toContain('http://localhost:5174')
  })

  it('does NOT inject CSP for internal chrome/devtools URLs', async () => {
    const { setupCSP } = await loadCsp()
    setupCSP('http://localhost:5174')
    const handler = h.onHeadersReceived.mock.calls[0]![0]

    const details = {
      url: 'devtools://devtools/bundled/Inspector.js',
      responseHeaders: { 'X-Orig': ['keep'] },
    }
    handler(details, h.callback)
    const out = h.callback.mock.calls[0]![0]
    expect(out.responseHeaders!['Content-Security-Policy']).toBeUndefined()
    expect(out.responseHeaders!['X-Orig']).toEqual(['keep'])
  })

  it('derives wsIp only when the dev origin hostname is localhost (not 127.0.0.1)', async () => {
    const { setupCSP } = await loadCsp()
    // origin is 127.0.0.1:5174 -> hostname is NOT 'localhost', so wsIp stays undefined
    // and the connect-src list should NOT contain ws://127.0.0.1:<port>.
    setupCSP('http://127.0.0.1:5174')
    const handler = h.onHeadersReceived.mock.calls[0]![0]

    const details = { url: 'http://127.0.0.1:5174/index.html', responseHeaders: {} }
    handler(details, h.callback)
    const policy = (
      h.callback.mock.calls[0]![0].responseHeaders!['Content-Security-Policy'] as string[]
    )[0]!
    expect(policy).toContain('ws://127.0.0.1:5174')
    // No extra 127.0.0.1 entry appended (wsIp is undefined branch).
    expect(policy).not.toContain('ws://127.0.0.1:5174 ws://127.0.0.1:5174')
  })

  it('keeps the 127.0.0.1 ws entry when the dev origin hostname is localhost', async () => {
    const { setupCSP } = await loadCsp()
    // A normal dev URL whose hostname is 'localhost' -> wsIp is derived and appended.
    setupCSP('http://localhost:5174')
    const handler = h.onHeadersReceived.mock.calls[0]![0]
    const details = { url: 'http://localhost:5174/index.html', responseHeaders: {} }
    handler(details, h.callback)
    const policy = (
      h.callback.mock.calls[0]![0].responseHeaders!['Content-Security-Policy'] as string[]
    )[0]!
    expect(policy).toContain('ws://127.0.0.1:5174')
  })
})
