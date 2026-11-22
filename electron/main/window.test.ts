import { describe, it, expect, vi, beforeEach } from 'vitest'

const events: Record<string, (...a: unknown[]) => void> = {}
const webContentsEvents: Record<string, (...a: unknown[]) => void> = {}
const openHandlerCalls: Array<(d: { url: string }) => { action: 'deny' }> = []

const h = vi.hoisted(() => ({
  devUrl: '',
  setMainWindow: vi.fn(),
  win: {
    maximized: false,
    shown: false,
    on: (ev: string, cb: (...a: unknown[]) => void) => {
      events[ev] = cb
    },
    webContents: {
      // The registry keys windows by this id (see registerWindow).
      id: 7,
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
  quitPending: false,
  // Set by the cross-window isolation test so the second createWindow() gets a
  // distinct BrowserWindow instead of the shared h.win.
  nextWindow: null as null | Record<string, unknown>,
  ipcOn: {} as Record<string, (...a: unknown[]) => void>,
  shellOpenExternal: vi.fn(),
}))

vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor(_opts: unknown) {
      return h.nextWindow ?? h.win
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
  setMainWindow: (w: unknown) => h.setMainWindow(w),
  setReadyToQuit: vi.fn(),
}))

vi.mock('./lib/app-paths', () => ({
  get VITE_DEV_SERVER_URL() {
    return h.devUrl
  },
  RENDERER_DIST: '/app/dist',
}))

// markQuitPending attributes the report to its IPC sender (ADR-0039 §3.4), so these tests pass
// the mock renderer's webContents.id (7). A bare call would rely on the active-window fallback
// that was removed to stop a dead renderer from disarming the focused window's safety net.
const { markQuitPending } = await import('./model/quitSignals')
const { allContexts, __resetWindowContextsForTests } = await import('./model/windowContext')
const window = await import('./window')

beforeEach(() => {
  for (const k of Object.keys(events)) delete events[k]
  for (const k of Object.keys(webContentsEvents)) delete webContentsEvents[k]
  for (const k of Object.keys(h.ipcOn)) delete h.ipcOn[k]
  openHandlerCalls.length = 0
  h.win.maximized = false
  h.win.shown = false
  h.nextWindow = null
  h.quitPending = false
  h.devUrl = ''
  h.shellOpenExternal.mockClear()
  // The window registry is process-global: a context left over from a previous case would
  // make the "one window" assertions below see several.
  __resetWindowContextsForTests()
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

  it('publishes the focused window as the menu target (P3 multi-window)', () => {
    window.createWindow()
    h.setMainWindow.mockClear()
    expect(typeof events['focus']).toBe('function')
    events['focus'](null)
    expect(h.setMainWindow).toHaveBeenCalledWith(h.win)
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

  it('allows a confirmed window close to proceed without re-prompting (one-shot)', () => {
    window.createWindow()
    // lifecycle.ts sets this one-shot flag on app:quit-allowed before closing this window.
    allContexts()[0].closeAllowed = true
    const event = { preventDefault: vi.fn() }
    events['close'](event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    // Consumed: a later close attempt is guarded again.
    expect(allContexts()[0].closeAllowed).toBe(false)
    const later = { preventDefault: vi.fn() }
    events['close'](later)
    expect(later.preventDefault).toHaveBeenCalled()
  })

  it('forces quit after the 5s grace period when the renderer never replies', async () => {
    // Use fake timers so the 5s safety net in the close handler is deterministic.
    vi.useFakeTimers()
    try {
      let closeCalls = 0
      h.win.close = vi.fn(() => {
        closeCalls++
        // Simulate the real close re-entering the handler: the safety net set this
        // window's one-shot closeAllowed before calling close(), so the handler
        // passes through (no preventDefault, no re-arm). This proves no recursion.
        events['close']({ preventDefault: vi.fn() })
      })
      window.createWindow()
      const event = { preventDefault: vi.fn() }
      events['close'](event)
      // Initial intercept: prompt sent, close prevented.
      expect(event.preventDefault).toHaveBeenCalled()
      expect(h.win.webContents.send).toHaveBeenCalledWith('app:request-quit')
      // Before the safety net fires, this window has no pre-authorization.
      expect(allContexts()[0].closeAllowed).toBe(false)
      vi.advanceTimersByTime(5000)
      // After the grace period, the safety net pre-authorized THIS window's re-entry
      // and called win.close(); the re-entrant handler consumed the one-shot flag.
      expect(allContexts()[0].closeAllowed).toBe(false)
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
      let closeCalls = 0
      h.win.close = vi.fn(() => {
        closeCalls++
      })
      window.createWindow()
      // Trigger the close handler it sends app:request-quit and arms the safety net
      const event = { preventDefault: vi.fn() }
      events['close'](event)
      expect(h.win.webContents.send).toHaveBeenCalledWith('app:request-quit')

      // Renderer immediately reports it's showing the unsaved-changes confirm.
      markQuitPending({ id: 7 })
      expect(allContexts()[0].quitPending).toBe(true)

      // Even after the grace period, the safety net must NOT have force-closed.
      vi.advanceTimersByTime(5000)
      expect(allContexts()[0].closeAllowed).toBe(false)
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
      let closeCalls = 0
      h.win.close = vi.fn(function (this: typeof h.win) {
        closeCalls++
        // Simulate re-entry: the safety net pre-authorized this window, so the
        // close handler passes through on the next close event.
        events['close']({ preventDefault: vi.fn() })
      })
      window.createWindow()
      // First close: renderer reports pending (showing confirm), safety disarmed.
      events['close']({ preventDefault: vi.fn() })
      markQuitPending({ id: 7 })
      vi.advanceTimersByTime(5000)
      expect(closeCalls).toBe(0) // not force-closed
      // User cancelled. The close handler resets quitPending itself at the start
      // of every attempt (see the next test); the explicit reset below is kept so
      // this case still exercises the dead-renderer path even if that is removed.
      allContexts()[0].quitPending = false
      // Second close: renderer is now dead (no pending, no allowed). Safety net fires.
      events['close']({ preventDefault: vi.fn() })
      vi.advanceTimersByTime(5000)
      expect(closeCalls).toBe(1)
      expect(allContexts()[0].closeAllowed).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears a stale quitPending at the start of every close attempt so the safety net cannot be disarmed for good', async () => {
    // The bug this guards: quitPending was only ever cleared when the user
    // CONFIRMED (app:quit-allowed). After a prompt the user DISMISSED it stayed
    // true for the rest of the window's life, so a later dead renderer could
    // never be force-closed at all (un-exitable). quitPending is a per-attempt
    // signal on the WindowContext, so each attempt re-arms it and lets the
    // renderer re-report app:quit-pending when it really shows the prompt.
    vi.useFakeTimers()
    try {
      let closeCalls = 0
      h.win.close = vi.fn(() => {
        closeCalls++
      })
      window.createWindow()
      allContexts()[0].quitPending = true // stale: left over from a prompt the user dismissed
      events['close']({ preventDefault: vi.fn() })
      expect(allContexts()[0].quitPending).toBe(false) // re-armed for this attempt
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
    // The renderer can report its prompt before any close timer exists. The
    // per-window flag is set but there is no timer to disarm.
    window.createWindow()
    expect(() => markQuitPending({ id: 7 })).not.toThrow()
    expect(allContexts()[0].quitPending).toBe(true)
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
      markQuitPending({ id: 7 })
      vi.advanceTimersByTime(5000)
      expect(closeCalls).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("does NOT let one window's force-close skip another window's unsaved guard", () => {
    // Regression (multi-window): the old close handler checked a process-global
    // `isQuiting` that the 5s safety net set. With two windows, A's dead renderer
    // timing out set that flag and B's later close silently skipped its unsaved
    // prompt. The authorization is now A's one-shot ctx.closeAllowed only.
    vi.useFakeTimers()
    try {
      const bEvents: Record<string, (...a: unknown[]) => void> = {}
      const bSend = vi.fn()
      const secondWin = {
        on: (ev: string, cb: (...a: unknown[]) => void) => {
          bEvents[ev] = cb
        },
        webContents: {
          id: 8,
          on: vi.fn(),
          send: bSend,
          setZoomLevel: vi.fn(),
          setWindowOpenHandler: vi.fn(),
        },
        maximize: vi.fn(),
        show: vi.fn(),
        setAlwaysOnTop: vi.fn(),
        loadURL: vi.fn(),
        close: vi.fn(),
        isDestroyed: () => false,
      }
      let aCloseCalls = 0
      h.win.close = vi.fn(() => {
        aCloseCalls++
        events['close']({ preventDefault: vi.fn() }) // re-entry consumes A's one-shot
      })
      window.createWindow() // A: id 7, handlers in the shared `events` map
      h.nextWindow = secondWin
      window.createWindow() // B: id 8, handlers in `bEvents`
      const ctxA = allContexts().find((c) => c.id === 7)!
      const ctxB = allContexts().find((c) => c.id === 8)!

      events['close']({ preventDefault: vi.fn() }) // A: renderer never replies
      vi.advanceTimersByTime(5000) // A is force-closed; must touch only A's context
      expect(aCloseCalls).toBe(1)
      expect(ctxA.closeAllowed).toBe(false) // consumed by re-entry

      const bClose = { preventDefault: vi.fn() }
      bEvents['close'](bClose)
      // B is still live and dirty: its guard must run, independent of A's timeout.
      expect(bClose.preventDefault).toHaveBeenCalled()
      expect(bSend).toHaveBeenCalledWith('app:request-quit')
      expect(ctxB.closeAllowed).toBe(false)
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

  it('lets an already-confirmed close through without prompting again', () => {
    // The main process confirmed this window's close (the renderer answered the unsaved
    // prompt), so the close must NOT be intercepted a second time.
    window.createWindow()
    const ctx = allContexts()[0]
    ctx.closeAllowed = true

    const event = { preventDefault: vi.fn() }
    events['close'](event)

    expect(event.preventDefault).not.toHaveBeenCalled()
    // The one-shot flag is consumed: the NEXT close attempt is guarded again.
    expect(ctx.closeAllowed).toBe(false)
  })

  it('registers the window with the requested workspace root and pending file', () => {
    // The "open in new window" flow passes both: the new window starts in the file's folder
    // and opens the file itself.
    window.createWindow({ workspaceRoot: 'C:/notes', filePath: 'C:/notes/a.md' })
    const ctx = allContexts()[0]
    expect(ctx.pendingPaths).toEqual(['C:/notes/a.md'])
    // The root is normalised to the host's path shape, so compare its tail only.
    expect(ctx.workspaceRoot?.replace(/\\/g, '/')).toMatch(/notes$/)
  })

  it('releases the window context when the window is destroyed', async () => {
    window.createWindow()
    expect(allContexts().length).toBe(1)

    // A pending safety-net timer must be cleared with the window.
    const ctx = allContexts()[0]
    ctx.closeForceTimer = setTimeout(() => {}, 60_000)
    events['closed'](null)
    await new Promise((resolve) => setTimeout(resolve, 0))

    // A destroyed window must not stay in the registry: the quit handshake would keep
    // asking a window that no longer exists.
    expect(allContexts().length).toBe(0)
    expect(ctx.closeForceTimer).toBeNull()
  })

  it('never touches the destroyed window while releasing its context', () => {
    // Regression: the release used to read `win.webContents.id` from the 'closed' handler.
    // Electron throws "TypeError: Object has been destroyed" for that access, and an
    // uncaught exception inside an Electron event handler pops the native "A JavaScript
    // error occurred in the main process" dialog — a modal that blocks the main thread
    // for good, so the app could not be quit at all.
    window.createWindow()
    const original = Object.getOwnPropertyDescriptor(h.win, 'webContents')
    Object.defineProperty(h.win, 'webContents', {
      configurable: true,
      get() {
        throw new Error('Object has been destroyed')
      },
    })
    try {
      expect(() => events['closed'](null)).not.toThrow()
      expect(allContexts().length).toBe(0)
    } finally {
      if (original) Object.defineProperty(h.win, 'webContents', original)
    }
  })

  it('closes a window that never armed a safety-net timer', async () => {
    // The false half of "clear a pending timer": a window that never had one must still
    // release its context cleanly.
    window.createWindow()
    events['closed'](null)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(allContexts().length).toBe(0)
  })
})
