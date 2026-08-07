import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Shared fakes (hoisted so the electron mock factory can reference them) ───
// We capture the `app.on(...)`, `ipcMain.on(...)` and `ipcMain.handle(...)` registrations
// so the tests can invoke the real `before-quit` handler (and the `app:quit-allowed`
// handler that flips the module-internal `readyToQuit` flag) after the module loads.
const h = vi.hoisted(() => {
  const appHandlers: Record<string, (...a: unknown[]) => void> = {}
  const ipcOn: Record<string, (...a: unknown[]) => void> = {}
  const ipcHandle: Record<string, (...a: unknown[]) => void> = {}
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
  return { appHandlers, ipcOn, ipcHandle, fakeQuit, fakeWebContentsSend, fakeWindow }
})

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
    handle: (ch: string, fn: (...a: unknown[]) => void) => {
      h.ipcHandle[ch] = fn
    },
    on: (ch: string, fn: (...a: unknown[]) => void) => {
      h.ipcOn[ch] = fn
    },
  }
  class BrowserWindow {
    // Return the shared fake window instance so `mainWindow` is assignable/inspectable.
    constructor() {
      return h.fakeWindow as unknown as Electron.BrowserWindow
    }
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
    BrowserWindow,
    session,
    screen,
    Menu,
    protocol,
    nativeTheme,
    dialog,
    shell,
  }
})

// The following module-level mocks use paths relative to THIS test file
// (vi.mock resolves the specifier from the test file location).
vi.mock('../db/database', () => ({
  initDatabase: vi.fn(),
  getDb: () => ({
    prepare: () => ({
      get: () => undefined,
      run: () => ({}),
    }),
  }),
}))
vi.mock('../ipc/documents', () => ({ registerDocumentHandlers: vi.fn() }))
vi.mock('../ipc/search', () => ({ registerSearchHandlers: vi.fn() }))
vi.mock('../ipc/export', () => ({ registerExportHandlers: vi.fn() }))
vi.mock('../lib/security', () => ({
  isSubdir: () => true,
  APPDOC_MIME: {},
  parseAppDocUrl: () => null,
}))
vi.mock('../i18n', () => ({
  getCurrentLocale: () => 'en',
  menuT: (k: string) => k,
  setMenuLanguage: vi.fn(),
  initMenuI18n: vi.fn(),
}))

// Load the module and let `app.whenReady().then(...)` microtasks settle so that
// `createWindow()` assigns the module-internal `mainWindow`.
async function loadIndex(): Promise<void> {
  await import('../index.js')
  await Promise.resolve()
  await Promise.resolve()
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
    await loadIndex()

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
    await loadIndex()

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
    await loadIndex()

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
    await loadIndex()

    const evt = { preventDefault: vi.fn() }
    h.appHandlers['before-quit'](evt)

    expect(evt.preventDefault).not.toHaveBeenCalled()
    expect(h.fakeWebContentsSend).not.toHaveBeenCalledWith('app:request-quit')

    vi.advanceTimersByTime(5000)
    expect(h.fakeQuit).not.toHaveBeenCalled()
  })
})
