import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hold the exposed-api spy outside the mock factory so we can assert on it.
const h = vi.hoisted(() => ({
  expose: vi.fn(),
}))

// Mock electron's contextBridge so importing index.ts (which calls
// contextBridge.exposeInMainWorld at module top level) doesn't need a real
// Electron runtime. No other electron surface is used by index.ts.
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: h.expose,
  },
}))

// The exact set of keys index.ts must compose onto window.api. Keep this in
// lock-step with electron/preload/index.ts: 9 domain APIs + 5 event
// subscriptions spread to the top level.
const EXPECTED_API_KEYS = [
  'documents',
  'export',
  'search',
  'app',
  'clipboard',
  'files',
  'dialog',
  'window',
  'menu',
  'onMenuEvent',
  'onFileChanged',
  'onFolderChanged',
  'onOpenPaths',
  'onAppRequestQuit',
]

describe('preload index (window.api composition)', () => {
  beforeEach(() => {
    h.expose.mockClear()
    // Each import re-runs index.ts's top-level exposeInMainWorld, so reset
    // module registry between tests to keep assertions isolated.
    vi.resetModules()
  })

  it('exposes the api object onto window.api exactly once', async () => {
    await import('./index')
    expect(h.expose).toHaveBeenCalledTimes(1)
    expect(h.expose.mock.calls[0]?.[0]).toBe('api')
  })

  it('exposes the precise, complete api contract (no missing or extra keys)', async () => {
    await import('./index')
    const exposed = h.expose.mock.calls[0]?.[1] as Record<string, unknown>

    // No missing keys.
    for (const key of EXPECTED_API_KEYS) {
      expect(exposed).toHaveProperty(key)
      expect(exposed[key]).toBeDefined()
    }
    // No extra keys (guards against accidental over-exposure).
    expect(Object.keys(exposed).sort()).toEqual([...EXPECTED_API_KEYS].sort())
  })
})
