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
vi.mock('./state', () => {
  let mainWindow: unknown = null
  let isQuiting = false
  let readyToQuit = false
  let quitPending = false
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
    getQuitPending: () => quitPending,
    setQuitPending: (v: boolean) => {
      quitPending = v
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
  stopFolderWatching: vi.fn(async () => {
    h.stopFolderWatchingCalled = true
  }),
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
  // Reset the state mock's closure-scoped flags. vi.resetModules() invalidates the
  // module cache but the mock factory's closure variables (isQuiting / readyToQuit /
  // quitPending) persist across re-imports within the same test file, so a flag set
  // by a previous test would leak into the next one and change the before-quit /
  // safety-net branch. Importing here returns the same singleton instance the
  // production code will use, so resetting it zeroes the shared state for each test.
  const state = await import('./state.js')
  state.setIsQuiting(false)
  state.setReadyToQuit(false)
  state.setQuitPending(false)
  state.setMainWindow(null)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('main process — before-quit safety net', () => {
  it('forces app.quit() after the 5s grace period when the renderer never replies', async () => {
    h.fakeWindow.isDestroyed = () => false
    const state = await import('./state.js')
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
    const state = await import('./state.js')
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

  it('does nothing (no prompt, no forced quit) when the window is already destroyed', async () => {
    h.fakeWindow.isDestroyed = () => true
    const state = await import('./state.js')
    state.setMainWindow(h.fakeWindow as unknown as Electron.BrowserWindow)
    await loadLifecycle()

    const evt = { preventDefault: vi.fn() }
    h.appHandlers['before-quit'](evt)

    expect(evt.preventDefault).not.toHaveBeenCalled()
    expect(h.fakeWebContentsSend).not.toHaveBeenCalledWith('app:request-quit')

    vi.advanceTimersByTime(5000)
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

  it('does NOT force quit when the renderer reports an unsaved-changes prompt is open (app:quit-pending)', async () => {
    // Regression: dirty workspace + close → renderer shows confirm box and sends
    // app:quit-pending. The 5s safety net must be disarmed so the user has unlimited
    // time to decide; otherwise the safety net would force-quit 5s after the prompt
    // opened, silently discarding the user's edits.
    h.fakeWindow.isDestroyed = () => false
    const state = await import('./state.js')
    state.setMainWindow(h.fakeWindow as unknown as Electron.BrowserWindow)
    await loadLifecycle()

    const evt = { preventDefault: vi.fn() }
    h.appHandlers['before-quit'](evt)
    expect(h.fakeWebContentsSend).toHaveBeenCalledWith('app:request-quit')
    h.fakeQuit.mockClear()

    // Renderer opens the unsaved-changes confirm and immediately reports it.
    h.ipcOn['app:quit-pending']()
    expect(state.getQuitPending()).toBe(true)

    // Even after the grace period elapses, the safety net must NOT force-quit because
    // quitPending is true (the renderer is alive, just waiting on the user).
    vi.advanceTimersByTime(5000)
    expect(h.fakeQuit).not.toHaveBeenCalled()
    expect(state.getQuitPending()).toBe(true)
  })

  it('still force-quits after the grace period when the renderer never replies AND never reports pending', async () => {
    // The "renderer is dead" path: no app:quit-pending, no app:quit-allowed. The
    // safety net must still fire so the app can never get stuck un-exitable.
    // (This is the original safety-net behavior, preserved.)
    h.fakeWindow.isDestroyed = () => false
    const state = await import('./state.js')
    state.setMainWindow(h.fakeWindow as unknown as Electron.BrowserWindow)
    await loadLifecycle()

    const evt = { preventDefault: vi.fn() }
    h.appHandlers['before-quit'](evt)
    h.fakeQuit.mockClear()

    // Renderer is silent (crashed / detached). quitPending stays false.
    expect(state.getQuitPending()).toBe(false)
    vi.advanceTimersByTime(5000)
    expect(h.fakeQuit).toHaveBeenCalledTimes(1)
  })

  it('clears quitPending and proceeds when the renderer later confirms (app:quit-allowed)', async () => {
    // User clicked "discard" in the unsaved-changes confirm: renderer sends
    // app:quit-allowed. quitPending must be cleared so a subsequent quit attempt
    // (e.g. user closes again after cancelling the first prompt) re-arms the
    // safety net rather than treating the now-stale pending as still active.
    h.fakeWindow.isDestroyed = () => false
    const state = await import('./state.js')
    state.setMainWindow(h.fakeWindow as unknown as Electron.BrowserWindow)
    await loadLifecycle()

    const evt = { preventDefault: vi.fn() }
    h.appHandlers['before-quit'](evt)
    h.ipcOn['app:quit-pending']()
    expect(state.getQuitPending()).toBe(true)

    h.fakeQuit.mockClear()
    h.ipcOn['app:quit-allowed']()
    expect(state.getQuitPending()).toBe(false)
    expect(state.getReadyToQuit()).toBe(true)
    expect(h.fakeQuit).toHaveBeenCalledTimes(1)
  })

  it('clears a stale quitPending at the start of every before-quit attempt', async () => {
    // Mirror of the window.ts close-handler guard. app:quit-allowed clears the flag
    // when the user CONFIRMS, but a prompt the user DISMISSED never sends anything,
    // so the flag stayed true for the rest of the process and this safety net was
    // skipped on every later attempt as well. A renderer that died afterwards could
    // then never be force-quit — un-exitable, the exact failure the net exists to
    // prevent. quitPending is per-attempt: re-arm it and let the renderer re-report.
    h.fakeWindow.isDestroyed = () => false
    const state = await import('./state.js')
    state.setMainWindow(h.fakeWindow as unknown as Electron.BrowserWindow)
    state.setQuitPending(true) // stale: left over from a dismissed prompt
    await loadLifecycle()

    const evt = { preventDefault: vi.fn() }
    h.appHandlers['before-quit'](evt)
    expect(state.getQuitPending()).toBe(false) // re-armed for this attempt
    h.fakeQuit.mockClear()
    vi.advanceTimersByTime(5000)
    expect(h.fakeQuit).toHaveBeenCalledTimes(1) // dead renderer still forced out
  })
})

describe('main process — will-quit watcher teardown', () => {
  it('awaits stopFolderWatching on will-quit so native handles close before exit', async () => {
    // will-quit fires after all windows are closed and before the process tears down.
    // The watcher must be closed (awaited) here so chokidar's native handles release.
    vi.useRealTimers()
    try {
      await loadLifecycle()
      h.stopFolderWatchingCalled = false
      await h.appHandlers['will-quit']({ preventDefault: vi.fn() })
      expect(h.stopFolderWatchingCalled).toBe(true)
    } finally {
      vi.useFakeTimers()
    }
  })

  it('does not throw when stopFolderWatching rejects on will-quit', async () => {
    vi.useRealTimers()
    try {
      const folderWatcher = await import('./model/folderWatcher.js')
      ;(folderWatcher.stopFolderWatching as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('watcher close failed'),
      )
      await loadLifecycle()
      // Should not throw — the catch in will-quit must swallow it so exit proceeds.
      await expect(h.appHandlers['will-quit']({ preventDefault: vi.fn() })).resolves.toBeUndefined()
    } finally {
      vi.useFakeTimers()
    }
  })
})
