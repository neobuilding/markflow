import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers: Record<string, (...a: unknown[]) => unknown> = {}
const h = vi.hoisted(() => ({ dark: false, themeSource: '' as string, applied: [] as string[] }))
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
// The menu module is mocked out: it pulls in Electron's Menu, which this unit does not provide,
// and the only thing the handler needs from it is the radio-group sync.
vi.mock('../menu', () => ({
  applyThemeToMenu: (theme: string) => {
    h.applied.push(theme)
  },
}))

import { registerThemeHandlers } from './theme'

describe('theme handlers', () => {
  beforeEach(() => {
    for (const k of Object.keys(handlers)) delete handlers[k]
    h.dark = false
    h.themeSource = ''
    h.applied.length = 0
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

  // The native theme menu's radio group must show the CURRENT choice, so the handler mirrors the
  // renderer's value into the menu (ADR-0028). The renderer stays the source of truth.
  it('set-theme mirrors the theme into the native menu so its radio group stays in sync', () => {
    handlers['app:set-theme'](null, 'dark')
    expect(h.applied).toEqual(['dark'])
    handlers['app:set-theme'](null, 'system')
    expect(h.applied).toEqual(['dark', 'system'])
  })
})
