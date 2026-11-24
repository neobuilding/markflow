import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Shared fakes (hoisted so the electron mock factory can reference them) ───
// We capture the `app.on(...)`, `ipcMain.on(...)` and `ipcMain.handle(...)` registrations
// so the tests can invoke the real `before-quit`, `window-all-closed`, `will-quit` and
// `app:quit-allowed` (single-window close confirmation) handlers after the module loads.
const h = vi.hoisted(() => {
  const appHandlers: Record<string, (...a: unknown[]) => void> = {}
  const ipcOn: Record<string, (...a: unknown[]) => void> = {}
  const fakeQuit = vi.fn()
  const fakeWebContentsSend = vi.fn()
  const fakeWindow: Record<string, unknown> = {
    on: vi.fn(),
    loadURL: vi.fn(),
    maximize: vi.fn(),
    show: vi.fn(),
    restore: vi.fn(),
    focus: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    isMinimized: () => false,
    isMaximized: () => true,
    isFocused: () => true,
    isDestroyed: () => true,
    webContents: {
      send: fakeWebContentsSend,
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      setZoomLevel: vi.fn(),
      isDevToolsOpened: () => false,
      openDevTools: vi.fn(),
      closeDevTools: vi.fn(),
    },
  }
  return {
    appHandlers,
    ipcOn,
    fakeQuit,
    fakeWebContentsSend,
    fakeWindow,
    purgeThrows: false,
    stopFolderWatchingCalled: false,
  }
})

// Mock `electron` FIRST (before importing lifecycle), so the module-top-level
// setupLifecycle() registrations are captured when lifecycle.ts is imported.
vi.mock('electron', () => {
  const app = {
    setPath: vi.fn(),
    getPath: (name: string) => `/fake/${name}`,
    getAppPath: () => '/fake/app',
    getVersion: () => '0.0.0',
    getLocale: () => 'en-US',
    isPackaged: false,
    setAppUserModelId: vi.fn(),
    whenReady: () => Promise.resolve(),
    on: (event: string, cb: (...a: unknown[]) => void) => {
      h.appHandlers[event] = cb
    },
    quit: h.fakeQuit,
    requestSingleInstanceLock: () => true,
  }
  const ipcMain = {
    handle: (_ch: string, _fn: (...a: unknown[]) => void) => {
      // lifecycle.ts only uses ipcMain.on
    },
    on: (ch: string, fn: (...a: unknown[]) => void) => {
      h.ipcOn[ch] = fn
    },
  }
  const session = {
    defaultSession: {
      webRequest: { onHeadersReceived: vi.fn() },
      setPermissionRequestHandler: vi.fn(),
    },
  }
  const screen = {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 100, height: 100 } }),
  }
  const Menu = {
    buildFromTemplate: () => ({ getMenuItemById: () => ({ enabled: false }) }),
    setApplicationMenu: vi.fn(),
  }
  const protocol = {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
  }
  const nativeTheme = { shouldUseDarkColors: false, themeSource: 'system' }
  const dialog = {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
    showMessageBox: vi.fn(),
  }
  const shell = { openExternal: vi.fn() }
  return {
    app,
    ipcMain,
    BrowserWindow: class {},
    session,
    screen,
    Menu,
    protocol,
    nativeTheme,
    dialog,
    shell,
  }
})

// Mock the shared state module: the exit flags are tracked for real so
// window-all-closed -> before-quit interactions behave correctly. The global
// quitPending mirror no longer exists (the per-window flag lives on WindowContext).
vi.mock('./state', () => {
  let mainWindow: unknown = null
  let readyToQuit = false
  return {
    getMainWindow: () => mainWindow,
    setMainWindow: (w: unknown) => {
      mainWindow = w
    },
    getReadyToQuit: () => readyToQuit,
    setReadyToQuit: (v: boolean) => {
      readyToQuit = v
    },
    pendingInitialPaths: [] as string[],
  }
})

vi.mock('./model/documentStore', () => ({
  purgeUnsavedDrafts: vi.fn(() => {
    if (h.purgeThrows) throw new Error('purge failed')
    return 0
  }),
}))

vi.mock('./model/folderWatcher', () => ({
  stopAllFolderWatching: vi.fn(async () => {
    h.stopFolderWatchingCalled = true
  }),
}))

// Mock the temp-cleanup module so the will-quit handler's cleanup calls are observable
// (we assert they fire with the right path, in the right order, in EVERY mode — ADR-0016
// removed the test-only e2e-skip branch) without touching the real filesystem or
// spawning a detached deleter inside the unit suite.
vi.mock('./lib/temp-cleanup', () => ({
  removeOwnTempDir: vi.fn(() => true),
  scheduleRemoveAfterExit: vi.fn(),
  OWN_TEMP_DIR_NAME: 'markflow',
}))

async function loadLifecycle(): Promise<void> {
  // lifecycle.ts registers its handlers via an explicit setupLifecycle() call
  // (the module does NOT self-execute on import, so it is not tree-shaken away
  // by Rollup). We must invoke it here for the app_before-quit / app:quit-allowed
  // handlers to be registered on the mocked app/ipcMain.
  const lifecycle = await import('./lifecycle.js')
  lifecycle.setupLifecycle()
}

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  // Default: window considered destroyed (so the prompt/safety-net branch is skipped).
  h.fakeWindow.isDestroyed = () => true
  h.purgeThrows = false
  h.stopFolderWatchingCalled = false
  h.fakeQuit.mockClear()
  h.fakeWebContentsSend.mockClear()
  // Reset the state mock's closure-scoped flag. vi.resetModules() invalidates the
  // module cache but the mock factory's closure variable (readyToQuit) persists
  // across re-imports within the same test file, so a flag set by a previous test
  // would leak into the next one. Importing here returns the same singleton
  // instance the production code will use, so resetting it zeroes shared state.
  const state = await import('./state.js')
  state.setReadyToQuit(false)
  state.setMainWindow(null)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('main process — before-quit (no app-level handshake)', () => {
  it('never prompts or defers an app quit: no preventDefault, no app:request-quit fan-out', async () => {
    h.fakeWindow.isDestroyed = () => false
    const wc = await import('./model/windowContext.js')
    wc.__resetWindowContextsForTests()
    const a = fakeCtxWindow(7)
    wc.registerWindow(a.win as never)
    await loadLifecycle()

    const evt = { preventDefault: vi.fn() }
    h.appHandlers['before-quit'](evt)

    expect(evt.preventDefault).not.toHaveBeenCalled()
    expect(a.sent).not.toContain('app:request-quit')
    expect(h.fakeWebContentsSend).not.toHaveBeenCalledWith('app:request-quit')
    vi.advanceTimersByTime(5000)
    // No per-window force-quit timer is armed by before-quit any more.
    expect(h.fakeQuit).not.toHaveBeenCalled()
  })

  it('purges drafts and quits immediately when readyToQuit is already set', async () => {
    h.fakeWindow.isDestroyed = () => false
    const state = await import('./state.js')
    state.setMainWindow(h.fakeWindow as unknown as Electron.BrowserWindow)
    await loadLifecycle()

    // Renderer already allowed the previous quit attempt.
    h.ipcOn['app:quit-allowed']()
    h.fakeQuit.mockClear()

    const evt = { preventDefault: vi.fn() }
    h.appHandlers['before-quit'](evt)

    // readyToQuit branch short-circuits: no re-prompt, no preventDefault, draft purge runs.
    expect(evt.preventDefault).not.toHaveBeenCalled()
    expect(h.fakeWebContentsSend).not.toHaveBeenCalledWith('app:request-quit')
    vi.advanceTimersByTime(5000)
    // No extra forced quits from a safety net (none was armed).
    expect(h.fakeQuit).not.toHaveBeenCalled()
  })

  it('quits when the last window is closed (window-all-closed)', async () => {
    h.fakeWindow.isDestroyed = () => true
    const state = await import('./state.js')
    state.setMainWindow(h.fakeWindow as unknown as Electron.BrowserWindow)
    await loadLifecycle()

    h.fakeQuit.mockClear()
    h.appHandlers['window-all-closed']()
    expect(h.fakeQuit).toHaveBeenCalledTimes(1)
  })

  it('purges drafts via the store on the readyToQuit fast path', async () => {
    h.fakeWindow.isDestroyed = () => false
    const state = await import('./state.js')
    const docStore = await import('./model/documentStore.js')
    state.setMainWindow(h.fakeWindow as unknown as Electron.BrowserWindow)
    await loadLifecycle()

    // Flip readyToQuit so before-quit takes the immediate purge-and-quit branch.
    state.setReadyToQuit(true)
    const evt = { preventDefault: vi.fn() }
    h.appHandlers['before-quit'](evt)

    expect(evt.preventDefault).not.toHaveBeenCalled()
    expect(h.fakeWebContentsSend).not.toHaveBeenCalledWith('app:request-quit')
    expect(docStore.purgeUnsavedDrafts).toHaveBeenCalled()
  })

  it('purges every registered window store on before-quit (ADR-0040)', async () => {
    h.fakeWindow.isDestroyed = () => false
    const state = await import('./state.js')
    const docStore = await import('./model/documentStore.js')
    const contexts = await import('./model/windowContext.js')
    contexts.__resetWindowContextsForTests()
    const fakeWindow = h.fakeWindow as unknown as Electron.BrowserWindow
    Object.defineProperty(fakeWindow.webContents, 'id', { value: 4242, configurable: true })
    contexts.registerWindow(fakeWindow)
    await loadLifecycle()
    state.setReadyToQuit(true)
    h.appHandlers['before-quit']({ preventDefault: vi.fn() })
    expect(docStore.purgeUnsavedDrafts).toHaveBeenCalled()
    contexts.__resetWindowContextsForTests()
  })

  it('still quits when purging unsaved drafts throws', async () => {
    h.fakeWindow.isDestroyed = () => false
    const state = await import('./state.js')
    const docStore = await import('./model/documentStore.js')
    h.purgeThrows = true
    state.setMainWindow(h.fakeWindow as unknown as Electron.BrowserWindow)
    await loadLifecycle()

    state.setReadyToQuit(true)
    const evt = { preventDefault: vi.fn() }
    h.appHandlers['before-quit'](evt)

    // The catch swallows the purge error and the quit still proceeds (before-quit is
    // not prevented, so the OS quit continues).
    expect(evt.preventDefault).not.toHaveBeenCalled()
    expect(docStore.purgeUnsavedDrafts).toHaveBeenCalled()
  })
})

describe('main process — will-quit watcher teardown', () => {
  it('runs BOTH temp-cleanup calls synchronously before the awaited watcher close', async () => {
    // will-quit fires after all windows are closed and before the process tears down.
    // The watcher must be closed (awaited) here so chokidar's native handles release,
    // and THEN the app must remove its own user-data-dir so %TEMP% stays clean.
    vi.useRealTimers()
    try {
      await loadLifecycle()
      h.stopFolderWatchingCalled = false
      await h.appHandlers['will-quit']({ preventDefault: vi.fn() })
      const tempCleanup = await import('./lib/temp-cleanup.js')
      const folderWatcher = await import('./model/folderWatcher.js')
      // Temp cleanup must run FIRST — synchronously, BEFORE the async folder-watcher
      // close. If it were gated behind the awaited close, a process that exits before
      // the await settles would silently skip %TEMP% cleanup and rot the temp dir.
      expect(folderWatcher.stopAllFolderWatching).toHaveBeenCalled()
      // `toHaveBeenCalledBefore` takes a MockInstance; the mocked module's static type is the real
      // `() => Promise<void>` signature, so narrow it the same way the rejection test below does.
      expect(tempCleanup.removeOwnTempDir).toHaveBeenCalledBefore(
        folderWatcher.stopAllFolderWatching as ReturnType<typeof vi.fn>,
      )
      // ADR-0036 §4 pins BOTH halves of "first and synchronously": moving just the
      // deferred-deleter scheduling behind the awaited close used to stay green.
      expect(tempCleanup.scheduleRemoveAfterExit).toHaveBeenCalledBefore(
        folderWatcher.stopAllFolderWatching as ReturnType<typeof vi.fn>,
      )
      expect(h.stopFolderWatchingCalled).toBe(true)
      expect(tempCleanup.removeOwnTempDir).toHaveBeenCalledWith('/fake/userData')
      // Regression guard: the exit-time cleanup twice did NOTHING because the deferred
      // deleter was never spawned. Chromium re-creates Preferences / Local State during
      // teardown, so scheduling is required, not merely a fallback for a failed sync remove.
      expect(tempCleanup.scheduleRemoveAfterExit).toHaveBeenCalledWith('/fake/userData')
    } finally {
      vi.useFakeTimers()
    }
  })

  it('does not throw when stopFolderWatching rejects, and still cleans up', async () => {
    vi.useRealTimers()
    try {
      const folderWatcher = await import('./model/folderWatcher.js')
      ;(folderWatcher.stopAllFolderWatching as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('watcher close failed'),
      )
      await loadLifecycle()
      const tempCleanup = await import('./lib/temp-cleanup.js')
      // The catch on stopFolderWatching must swallow the rejection so exit proceeds,
      // AND cleanup must still run so the app does not leave its temp dir behind.
      await expect(h.appHandlers['will-quit']({ preventDefault: vi.fn() })).resolves.toBeUndefined()
      expect(tempCleanup.removeOwnTempDir).toHaveBeenCalledWith('/fake/userData')
    } finally {
      vi.useFakeTimers()
    }
  })

  // Removed: two cases named "…in non-e2e (production) mode" and "…in e2e mode too" flipped
  // `MARKFLOW_E2E` to cover a branch neither lifecycle.ts nor any other production module
  // reads any more. They therefore exercised the same code path twice (the stretch of the
  // e2e contract is pinned by the assertion above and by temp-cleanup.e2e.spec.ts).
})

// ─── Per-window quit negotiation (multi-window) ──────────────────────────────
//
// The quit handshake is per WINDOW: the main process asks every live window to run the same
// unsaved-changes prompt, and the reply is attributed to the window that sent it. The intent
// recorded before the prompt decides what an allowed reply means.

interface FakeCtxWindow {
  id: number
  destroyed: boolean
  closed: number
  sent: string[]
}

function fakeCtxWindow(id: number): FakeCtxWindow & { win: unknown } {
  const state = { id, destroyed: false, closed: 0, sent: [] as string[] }
  const win = {
    webContents: {
      id,
      send: (channel: string) => state.sent.push(channel),
    },
    isDestroyed: () => state.destroyed,
    close: () => {
      state.closed += 1
    },
  }
  // Object.assign, not a spread: the fake MUTATES `state` (closed / sent), and the test must
  // observe those mutations on the very object it holds.
  return Object.assign(state, { win })
}

describe('main process — app:quit-allowed closes only its own window', () => {
  beforeEach(async () => {
    const wc = await import('./model/windowContext.js')
    wc.__resetWindowContextsForTests()
  })

  it('closes only the requesting window; other windows and the process stay alive', async () => {
    const wc = await import('./model/windowContext.js')
    const a = fakeCtxWindow(7)
    const b = fakeCtxWindow(8)
    wc.registerWindow(a.win as never)
    wc.registerWindow(b.win as never)
    await loadLifecycle()
    h.fakeQuit.mockClear()

    h.ipcOn['app:quit-allowed']({ sender: { id: 7 } })

    expect(a.closed).toBe(1)
    expect(b.closed).toBe(0)
    expect(h.fakeQuit).not.toHaveBeenCalled()
  })

  it("disarms only the confirming window's per-window pending flag", async () => {
    // A prompt in window A must not change window B's safety-net state. There is no
    // global mirror any more: each WindowContext.quitPending is independent.
    const wc = await import('./model/windowContext.js')
    const a = fakeCtxWindow(7)
    const b = fakeCtxWindow(8)
    const ctxA = wc.registerWindow(a.win as never)
    const ctxB = wc.registerWindow(b.win as never)
    ctxA.quitPending = true
    ctxB.quitPending = true
    await loadLifecycle()

    h.ipcOn['app:quit-allowed']({ sender: { id: 7 } })

    expect(ctxA.quitPending).toBe(false)
    expect(ctxB.quitPending).toBe(true)
  })

  it('does not close a window that was already destroyed', async () => {
    const wc = await import('./model/windowContext.js')
    const a = fakeCtxWindow(7)
    wc.registerWindow(a.win as never)
    a.destroyed = true
    await loadLifecycle()

    h.ipcOn['app:quit-allowed']({ sender: { id: 7 } })

    // The window is gone: closing it again would throw.
    expect(a.closed).toBe(0)
  })

  it('keeps the process alive on macOS when the last window closes', async () => {
    // D14: macOS keeps the process alive (the Dock icon remains; `activate` reopens a window).
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      await loadLifecycle()
      h.fakeQuit.mockClear()

      h.appHandlers['window-all-closed']()

      expect(h.fakeQuit).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', { value: original })
    }
  })

  it('ignores a reply that cannot be attributed to a window', async () => {
    const wc = await import('./model/windowContext.js')
    const a = fakeCtxWindow(7)
    wc.registerWindow(a.win as never)
    await loadLifecycle()
    h.fakeQuit.mockClear()

    // An unknown sender must not be credited to the focused window: there is no
    // active-window fallback and no headless app.quit() path any more.
    h.ipcOn['app:quit-allowed']({ sender: { id: 999 } })

    expect(a.closed).toBe(0)
    expect(h.fakeQuit).not.toHaveBeenCalled()
  })
})
