import { describe, it, expect, vi, beforeEach } from 'vitest'

const events: Record<string, (...a: unknown[]) => void> = {}
const webContentsEvents: Record<string, (...a: unknown[]) => void> = {}
const openHandlerCalls: Array<(d: { url: string }) => { action: 'deny' }> = []

const h = vi.hoisted(() => ({
  devUrl: '',
  win: {
    maximized: false,
    shown: false,
    on: (ev: string, cb: (...a: unknown[]) => void) => {
      events[ev] = cb
    },
    webContents: {
      on: (ev: string, cb: (...a: unknown[]) => void) => {
        webContentsEvents[ev] = cb
      },
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setWindowOpenHandler: (cb: (d: { url: string }) => { action: 'deny' }) => {
        openHandlerCalls.push(cb)
      },
    },
    maximize: vi.fn(function (this: { maximized: boolean }) {
      h.win.maximized = true
    }),
    show: vi.fn(function (this: { shown: boolean }) {
      h.win.shown = true
    }),
    setAlwaysOnTop: vi.fn(),
    loadURL: vi.fn(),
  },
  isQuiting: false,
  shellOpenExternal: vi.fn(),
}))

vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor(_opts: unknown) {
      return h.win
    }
  },
  screen: {
    getPrimaryDisplay: () => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    }),
  },
  shell: {
    openExternal: (...args: unknown[]) => h.shellOpenExternal(...args),
  },
}))

vi.mock('./state', () => ({
  setMainWindow: vi.fn(),
  getIsQuiting: () => h.isQuiting,
}))

vi.mock('./lib/app-paths', () => ({
  get VITE_DEV_SERVER_URL() {
    return h.devUrl
  },
  RENDERER_DIST: '/app/dist',
}))

const window = await import('./window')

beforeEach(() => {
  for (const k of Object.keys(events)) delete events[k]
  for (const k of Object.keys(webContentsEvents)) delete webContentsEvents[k]
  openHandlerCalls.length = 0
  h.win.maximized = false
  h.win.shown = false
  h.isQuiting = false
  h.devUrl = ''
  h.shellOpenExternal.mockClear()
  vi.clearAllMocks()
})

describe('createWindow', () => {
  it('creates, registers, and shows the main window', () => {
    window.createWindow()
    expect(h.win.loadURL).toHaveBeenCalled()
    expect(typeof events['ready-to-show']).toBe('function')
    events['ready-to-show'](null)
    expect(h.win.maximized).toBe(true)
    expect(h.win.shown).toBe(true)
  })

  it('tolerates setAlwaysOnTop throwing in ready-to-show', () => {
    h.win.setAlwaysOnTop = vi.fn(() => {
      throw new Error('nope')
    })
    window.createWindow()
    events['ready-to-show'](null)
    expect(h.win.shown).toBe(true)
  })

  it('denies external window opens and routes them through shell', () => {
    window.createWindow()
    expect(openHandlerCalls.length).toBe(1)
    const result = openHandlerCalls[0]({ url: 'https://example.com' })
    expect(result).toEqual({ action: 'deny' })
    expect(h.shellOpenExternal).toHaveBeenCalledWith('https://example.com')
  })

  it('resets zoom on did-finish-load', () => {
    window.createWindow()
    expect(typeof webContentsEvents['did-finish-load']).toBe('function')
    webContentsEvents['did-finish-load'](null)
    expect(h.win.webContents.setZoomLevel).toHaveBeenCalledWith(0)
  })

  it('prevents close and requests quit when not already quitting', () => {
    window.createWindow()
    expect(typeof events['close']).toBe('function')
    const event = { preventDefault: vi.fn() }
    events['close'](event)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(h.win.webContents.send).toHaveBeenCalledWith('app:request-quit')
  })

  it('allows close to proceed when already quitting', () => {
    h.isQuiting = true
    window.createWindow()
    const event = { preventDefault: vi.fn() }
    events['close'](event)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('loads the dev server URL when running in development', () => {
    h.devUrl = 'http://localhost:5173/'
    window.createWindow()
    expect(h.win.loadURL).toHaveBeenCalledWith('http://localhost:5173/')
  })
})
