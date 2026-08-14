import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers: Record<string, (...a: unknown[]) => unknown> = {}
const h = vi.hoisted(() => ({ dark: false, themeSource: '' as string }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => {
      handlers[ch] = fn
    },
  },
  nativeTheme: {
    get shouldUseDarkColors() {
      return h.dark
    },
    set themeSource(v: string) {
      h.themeSource = v
    },
  },
}))

import { registerThemeHandlers } from '../theme'

describe('theme handlers', () => {
  beforeEach(() => {
    for (const k of Object.keys(handlers)) delete handlers[k]
    h.dark = false
    h.themeSource = ''
    registerThemeHandlers()
  })

  it('get-theme reports dark when nativeTheme is dark', () => {
    h.dark = true
    expect(handlers['app:get-theme'](null)).toBe('dark')
    h.dark = false
    expect(handlers['app:get-theme'](null)).toBe('light')
  })

  it('set-theme forwards the theme source to nativeTheme', () => {
    handlers['app:set-theme'](null, 'dark')
    expect(h.themeSource).toBe('dark')
    handlers['app:set-theme'](null, 'system')
    expect(h.themeSource).toBe('system')
  })
})
