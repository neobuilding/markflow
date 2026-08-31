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
    close: vi.fn(),
    // Widened to `() => boolean`: individual tests swap this to `() => true` to
    // simulate the window being destroyed while the safety net is pending, and a
    // literal `() => false` would be inferred as the narrower `() => false` type.
    isDestroyed: (() => false) as () => boolean,
  },
  isQuiting: false,
  quitPending: false,
  ipcOn: {} as Record<string, (...a: unknown[]) => void>,
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
  ipcMain: {
    on: (ch: string, fn: (...a: unknown[]) => void) => {
      h.ipcOn[ch] = fn
    },
  },
}))

vi.mock('./state', () => ({
  setMainWindow: vi.fn(),
  getIsQuiting: () => h.isQuiting,
  setIsQuiting: (v: boolean) => {
    h.isQuiting = v
  },
  setReadyToQuit: vi.fn(),
  getQuitPending: () => h.quitPending,
  setQuitPending: (v: boolean) => {
    h.quitPending = v
  },
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
  for (const k of Object.keys(h.ipcOn)) delete h.ipcOn[k]
  openHandlerCalls.length = 0
  h.win.maximized = false
  h.win.shown = false
  h.isQuiting = false
  h.quitPending = false
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

  it('forces quit after the 5s grace period when the renderer never replies', async () => {
    // Use fake timers so the 5s safety net in the close handler is deterministic.
    vi.useFakeTimers()
    try {
      h.isQuiting = false
      let closeCalls = 0
      h.win.close = vi.fn(() => {
        closeCalls++
        // Simulate the real close re-entering the handler: with isQuiting now true,
        // the handler returns early (no preventDefault, no re-arm). This proves the
        // safety net does not recurse.
        h.isQuiting = true
        events['close']({ preventDefault: vi.fn() })
      })
      window.createWindow()
      const event = { preventDefault: vi.fn() }
      events['close'](event)
      // Initial intercept: prompt sent, close prevented.
      expect(event.preventDefault).toHaveBeenCalled()
      expect(h.win.webContents.send).toHaveBeenCalledWith('app:request-quit')
      // Before the safety net fires, isQuiting is still false.
      expect(h.isQuiting).toBe(false)
      vi.advanceTimersByTime(5000)
      // After the grace period, the safety net set isQuiting and called win.close().
      expect(h.isQuiting).toBe(true)
      expect(closeCalls).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT force quit after the grace period when the renderer reports an unsaved-changes prompt (app:quit-pending)', async () => {
    // Regression: dirty workspace → user closes window → renderer opens unsaved
    // confirm and sends app:quit-pending. The 5s safety net must be disarmed so
    // the user has unlimited time to decide; otherwise the safety net would
    // force-quit 5s after the prompt opened, silently discarding the user's edits.
    vi.useFakeTimers()
    try {
      h.isQuiting = false
      let closeCalls = 0
      h.win.close = vi.fn(() => {
        closeCalls++
      })
      window.createWindow()
      // Trigger the close handler — it sends app:request-quit and arms the safety net.
      const event = { preventDefault: vi.fn() }
      events['close'](event)
      expect(h.win.webContents.send).toHaveBeenCalledWith('app:request-quit')

      // Renderer immediately reports it's showing the unsaved-changes confirm.
      h.ipcOn['app:quit-pending']()
      expect(h.quitPending).toBe(true)

      // Even after the grace period, the safety net must NOT have force-closed.
      vi.advanceTimersByTime(5000)
      expect(h.isQuiting).toBe(false)
      expect(closeCalls).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still re-arms and can force-quit if the user cancels and a later close has no pending', async () => {
    // After the user cancelled the unsaved confirm (renderer silent), a subsequent
    // close attempt with no fresh app:quit-pending must still be bounded by the
    // safety net (the dead-renderer path is preserved).
    vi.useFakeTimers()
    try {
      h.isQuiting = false
      let closeCalls = 0
      h.win.close = vi.fn(function (this: typeof h.win) {
        closeCalls++
        // Simulate re-entry: once isQuiting is set by the safety net, the close
        // handler returns early on the next close event.
        h.isQuiting = true
        events['close']({ preventDefault: vi.fn() })
      })
      window.createWindow()
      // First close: renderer reports pending (showing confirm), safety disarmed.
      events['close']({ preventDefault: vi.fn() })
      h.ipcOn['app:quit-pending']()
      vi.advanceTimersByTime(5000)
      expect(closeCalls).toBe(0) // not force-closed
      // User cancelled. The close handler resets quitPending itself at the start
      // of every attempt (see the next test); the explicit reset below is kept so
      // this case still exercises the dead-renderer path even if that is removed.
      h.quitPending = false
      h.isQuiting = false
      // Second close: renderer is now dead (no pending, no allowed). Safety net fires.
      events['close']({ preventDefault: vi.fn() })
      vi.advanceTimersByTime(5000)
      expect(closeCalls).toBe(1)
      expect(h.isQuiting).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears a stale quitPending at the start of every close attempt so the safety net cannot be disarmed for good', async () => {
    // The bug this guards: quitPending was only ever cleared when the user
    // CONFIRMED (app:quit-allowed). After a prompt the user DISMISSED it stayed
    // true for the rest of the process, and both safety nets test it — the close
    // timer below and before-quit in lifecycle.ts. One dismissed prompt therefore
    // disabled both: if the renderer died afterwards the app could never be
    // force-quit at all (un-exitable), which is precisely what the net is for.
    // quitPending is a per-attempt signal, so each attempt must re-arm it and let
    // the renderer re-report app:quit-pending when it really shows the prompt.
    vi.useFakeTimers()
    try {
      h.isQuiting = false
      h.quitPending = true // stale: left over from a prompt the user dismissed
      let closeCalls = 0
      h.win.close = vi.fn(() => {
        closeCalls++
      })
      window.createWindow()
      events['close']({ preventDefault: vi.fn() })
      expect(h.quitPending).toBe(false) // re-armed for this attempt
      vi.advanceTimersByTime(5000)
      expect(closeCalls).toBe(1) // dead renderer is still forced closed
    } finally {
      vi.useRealTimers()
    }
  })

  it('loads the dev server URL when running in development', () => {
    h.devUrl = 'http://localhost:5173/'
    window.createWindow()
    expect(h.win.loadURL).toHaveBeenCalledWith('http://localhost:5173/')
  })

  it('loads the built index.html when running in production', () => {
    h.devUrl = ''
    window.createWindow()
    expect(h.win.loadURL).toHaveBeenCalledWith(expect.stringContaining('app/dist/index.html'))
  })

  it('handles app:quit-pending arriving with no close attempt in flight', () => {
    // The false branch of `if (closeForceTimer)` in the app:quit-pending handler:
    // the renderer can report its prompt before any close timer exists (e.g. the
    // quit was requested through the menu, which goes to before-quit, not here).
    window.createWindow()
    expect(() => h.ipcOn['app:quit-pending']()).not.toThrow()
    expect(h.quitPending).toBe(true)
  })

  it('cancels an already-armed safety net when the renderer reports a pending prompt', () => {
    // The true branch of `if (closeForceTimer) clearTimeout(...)`: a second close
    // attempt must replace the pending timer instead of stacking a second one,
    // otherwise N clicks produce N force-quits.
    vi.useFakeTimers()
    try {
      let closeCalls = 0
      h.win.close = vi.fn(() => {
        closeCalls++
      })
      window.createWindow()
      events['close']({ preventDefault: vi.fn() })
      events['close']({ preventDefault: vi.fn() }) // re-arms: clears the first timer
      h.ipcOn['app:quit-pending']()
      vi.advanceTimersByTime(5000)
      expect(closeCalls).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips the forced close when the renderer answered while the safety net was pending', () => {
    // The `getIsQuiting()` short-circuit inside the safety net: the renderer
    // replied (app:quit-allowed -> isQuiting) after the timer was armed but
    // before it fired. Force-closing then would yank the window away mid-quit.
    vi.useFakeTimers()
    try {
      let closeCalls = 0
      h.win.close = vi.fn(() => {
        closeCalls++
      })
      window.createWindow()
      events['close']({ preventDefault: vi.fn() })
      h.isQuiting = true // renderer answered in the meantime
      vi.advanceTimersByTime(5000)
      expect(closeCalls).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips win.close() when the window was destroyed while the safety net was pending', () => {
    // The `!win.isDestroyed()` guard: by the time the 5s timer fires the window
    // may already be gone, and calling close() on a destroyed window throws.
    vi.useFakeTimers()
    const original = h.win.isDestroyed
    try {
      let closeCalls = 0
      h.win.close = vi.fn(() => {
        closeCalls++
      })
      window.createWindow()
      events['close']({ preventDefault: vi.fn() })
      h.win.isDestroyed = () => true // window gone before the timer fired
      vi.advanceTimersByTime(5000)
      expect(closeCalls).toBe(0)
    } finally {
      h.win.isDestroyed = original
      vi.useRealTimers()
    }
  })

  it('applies darwin-specific window options (frame + hiddenInset title bar)', () => {
    // The `process.platform === 'darwin'` branches in the BrowserWindow options are
    // environment-dependent and never taken on Windows CI; force darwin to cover them.
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      window.createWindow()
      // Fire ready-to-show so the window is maximized (exercises the darwin branch path).
      events['ready-to-show'](null)
      expect(h.win.maximized).toBe(true)
    } finally {
      Object.defineProperty(process, 'platform', { value: original })
    }
  })
})
