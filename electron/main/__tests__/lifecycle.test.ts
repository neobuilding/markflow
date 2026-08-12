import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Shared fakes (hoisted so the electron mock factory can reference them) ───
// We capture the `app.on(...)`, `ipcMain.on(...)` and `ipcMain.handle(...)` registrations
// so the tests can invoke the real `before-quit` handler (and the `app:quit-allowed`
// handler that flips the module-internal `readyToQuit` flag) after the module loads.
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
  return { appHandlers, ipcOn, fakeQuit, fakeWebContentsSend, fakeWindow }
})

// Mock `electron` FIRST (before importing lifecycle), so the module-top-level
// setupLifecycle() registrations are captured when lifecycle.ts is imported.
vi.mock('electron', () => {
  const app = {
    setPath: vi.fn(),
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

// Mock the shared state module so the test controls getMainWindow() (the window
// instance lifecycle.ts reads in before-quit). The same mock instance is shared by
// lifecycle.ts because it resolves to the same absolute path. The quit flags are
// tracked for real so app:quit-allowed -> before-quit interactions behave correctly.
vi.mock('../state', () => {
  let mainWindow: unknown = null
  let isQuiting = false
  let readyToQuit = false
  return {
    getMainWindow: () => mainWindow,
    setMainWindow: (w: unknown) => {
      mainWindow = w
    },
    getIsQuiting: () => isQuiting,
    setIsQuiting: (v: boolean) => {
      isQuiting = v
    },
    getReadyToQuit: () => readyToQuit,
    setReadyToQuit: (v: boolean) => {
      readyToQuit = v
    },
    pendingInitialPaths: [] as string[],
  }
})

vi.mock('../db/database', () => ({
  initDatabase: vi.fn(),
  getDb: () => ({
    prepare: () => ({
      get: () => undefined,
      run: () => ({}),
    }),
  }),
}))

async function loadLifecycle(): Promise<void> {
  // lifecycle.ts registers its handlers via an explicit setupLifecycle() call
  // (the module does NOT self-execute on import, so it is not tree-shaken away
  // by Rollup). We must invoke it here for the app_before-quit / app:quit-allowed
  // handlers to be registered on the mocked app/ipcMain.
  const lifecycle = await import('../lifecycle.js')
  lifecycle.setupLifecycle()
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  // Default: window considered destroyed (so the prompt/safety-net branch is skipped).
  h.fakeWindow.isDestroyed = () => true
  h.fakeQuit.mockClear()
  h.fakeWebContentsSend.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('main process — before-quit safety net', () => {
  it('forces app.quit() after the 5s grace period when the renderer never replies', async () => {
    h.fakeWindow.isDestroyed = () => false
    const state = await import('../state.js')
    state.setMainWindow(h.fakeWindow as unknown as Electron.BrowserWindow)
    await loadLifecycle()

    const evt = { preventDefault: vi.fn() }
    h.appHandlers['before-quit'](evt)

    // The prompt was sent to the (alive) renderer and the quit was intercepted.
    expect(h.fakeWebContentsSend).toHaveBeenCalledWith('app:request-quit')
    expect(evt.preventDefault).toHaveBeenCalled()

    h.fakeQuit.mockClear()
    // Renderer never answers → the safety-net timer must force the quit so the
    // app can never get stuck un-exitable.
    vi.advanceTimersByTime(5000)
    expect(h.fakeQuit).toHaveBeenCalledTimes(1)
  })

  it('does NOT force quit from the safety net when the renderer replies before the grace period', async () => {
    h.fakeWindow.isDestroyed = () => false
    const state = await import('../state.js')
    state.setMainWindow(h.fakeWindow as unknown as Electron.BrowserWindow)
    await loadLifecycle()

    // The before-quit prompt is sent and the safety-net timer is armed.
    const evt = { preventDefault: vi.fn() }
    h.appHandlers['before-quit'](evt)
    expect(h.fakeWebContentsSend).toHaveBeenCalledWith('app:request-quit')
    h.fakeQuit.mockClear()

    // Before the 5s timer fires, the renderer confirms the unsaved-changes prompt,
    // which flips `readyToQuit`. The safety net must then be a no-op.
    h.ipcOn['app:quit-allowed']()
    expect(h.fakeQuit).toHaveBeenCalledTimes(1) // app:quit-allowed itself calls app.quit()

    vi.advanceTimersByTime(5000)
    // Safety net skipped because `readyToQuit` is now true.
    expect(h.fakeQuit).toHaveBeenCalledTimes(1)
  })

  it('purges drafts and quits immediately when readyToQuit is already set', async () => {
    h.fakeWindow.isDestroyed = () => false
    const state = await import('../state.js')
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

  it('does nothing (no prompt, no forced quit) when the window is already destroyed', async () => {
    h.fakeWindow.isDestroyed = () => true
    const state = await import('../state.js')
    state.setMainWindow(h.fakeWindow as unknown as Electron.BrowserWindow)
    await loadLifecycle()

    const evt = { preventDefault: vi.fn() }
    h.appHandlers['before-quit'](evt)

    expect(evt.preventDefault).not.toHaveBeenCalled()
    expect(h.fakeWebContentsSend).not.toHaveBeenCalledWith('app:request-quit')

    vi.advanceTimersByTime(5000)
    expect(h.fakeQuit).not.toHaveBeenCalled()
  })
})
