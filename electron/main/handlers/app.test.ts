import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers: Record<string, (...a: unknown[]) => unknown> = {}
const h = vi.hoisted(() => ({ version: '9.9.9', showItemErr: false }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => {
      handlers[ch] = fn
    },
  },
  shell: {
    showItemInFolder: (p: string) => {
      if (h.showItemErr) throw new Error('nope')
      return p
    },
  },
  app: { getVersion: () => h.version },
}))

import { registerAppHandlers } from './app'
import { pendingInitialPaths } from '../state'

describe('app handlers', () => {
  beforeEach(() => {
    for (const k of Object.keys(handlers)) delete handlers[k]
    pendingInitialPaths.length = 0
    registerAppHandlers()
  })

  it('drains pending initial paths', () => {
    pendingInitialPaths.push('/a.md', '/b.md')
    const out = handlers['app:get-initial-paths'](null) as string[]
    expect(out).toEqual(['/a.md', '/b.md'])
    // spliced empty
    expect(pendingInitialPaths.length).toBe(0)
  })

  it('shows a file in the folder via the shell', () => {
    handlers['app:show-in-folder'](null, '/x.md')
    expect(handlers['app:show-in-folder']).toBeDefined()
  })

  it('does not throw when showItemInFolder throws', () => {
    h.showItemErr = true
    expect(() => handlers['app:show-in-folder'](null, '/x.md')).not.toThrow()
    h.showItemErr = false
  })

  it('returns the app version', () => {
    expect(handlers['app:get-version'](null)).toBe('9.9.9')
  })
})
