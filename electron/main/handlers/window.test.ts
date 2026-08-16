import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers: Record<string, (...a: unknown[]) => unknown> = {}
const h = vi.hoisted(() => ({
  win: {
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    isMaximized: vi.fn(() => true),
  },
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => {
      handlers[ch] = fn
    },
  },
}))
vi.mock('../state', () => ({
  getMainWindow: () => h.win,
}))

import { registerWindowHandlers } from './window'

describe('window handlers', () => {
  beforeEach(() => {
    for (const k of Object.keys(handlers)) delete handlers[k]
    h.win.maximize.mockClear()
    h.win.unmaximize.mockClear()
    h.win.isMaximized.mockReturnValue(true)
    registerWindowHandlers()
  })

  it('maximize delegates to the main window', () => {
    handlers['window:maximize'](null)
    expect(h.win.maximize).toHaveBeenCalled()
  })

  it('unmaximize delegates to the main window', () => {
    handlers['window:unmaximize'](null)
    expect(h.win.unmaximize).toHaveBeenCalled()
  })

  it('is-maximized reports the window state', () => {
    h.win.isMaximized.mockReturnValue(true)
    expect(handlers['window:is-maximized'](null)).toBe(true)
    h.win.isMaximized.mockReturnValue(false)
    expect(handlers['window:is-maximized'](null)).toBe(false)
  })
})
