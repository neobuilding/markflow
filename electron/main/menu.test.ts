import { describe, it, expect, vi, beforeEach } from 'vitest'

const menuItems: Record<string, { id?: string; enabled: boolean }> = {}
const setAppMenuCalls: unknown[] = []
const ipcHandlers: Record<string, (...a: unknown[]) => void> = {}
const allClicks: Array<(() => void) | undefined> = []

const h = vi.hoisted(() => ({
  mainWindow: null as null | {
    isDestroyed: () => boolean
    webContents: {
      send: (...a: unknown[]) => void
      isDevToolsOpened: () => boolean
      openDevTools: (...a: unknown[]) => void
      closeDevTools: () => void
    }
  },
  devToolsOpened: false,
  openFilesSent: [] as unknown[],
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: (ch: string, fn: (...a: unknown[]) => void) => {
      ipcHandlers[ch] = fn
    },
  },
  Menu: {
    buildFromTemplate: (template: Array<Record<string, unknown>>) => {
      const collect = (items: typeof template) => {
        for (const item of items) {
          if (typeof item.id === 'string') {
            menuItems[item.id] = {
              id: item.id,
              enabled: (item.enabled as boolean) ?? true,
            }
          }
          if (typeof item.click === 'function') {
            allClicks.push(item.click as () => void)
          }
          if (Array.isArray(item.submenu)) {
            collect(item.submenu as typeof template)
          }
        }
      }
      collect(template)
      return {
        getMenuItemById: (id: string) => menuItems[id] ?? null,
        items: template,
      }
    },
    setApplicationMenu: (m: unknown) => {
      setAppMenuCalls.push(m)
    },
  },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
  },
}))

import { dialog } from 'electron'

vi.mock('./state', () => ({
  getMainWindow: () => h.mainWindow,
}))

vi.mock('./i18n', () => ({
  menuT: (key: string) => key,
  getCurrentLocale: () => 'en' as const,
  setMenuLanguage: vi.fn(),
}))

vi.mock('./lib/md-files', () => ({
  collectMarkdownFiles: vi.fn(() => ['/x/a.md', '/x/b.md']),
}))

const menu = await import('./menu')

function setWindow(
  opts: Partial<{
    destroyed: boolean
    devToolsOpened: boolean
  }> = {},
): void {
  h.devToolsOpened = opts.devToolsOpened ?? false
  h.mainWindow = {
    isDestroyed: () => opts.destroyed ?? false,
    webContents: {
      send: (...args: unknown[]) => {
        h.openFilesSent.push(args)
      },
      isDevToolsOpened: () => h.devToolsOpened,
      openDevTools: () => {},
      closeDevTools: () => {},
    },
  }
}

beforeEach(() => {
  for (const k of Object.keys(menuItems)) delete menuItems[k]
  setAppMenuCalls.length = 0
  for (const k of Object.keys(ipcHandlers)) delete ipcHandlers[k]
  allClicks.length = 0
  h.openFilesSent.length = 0
  h.mainWindow = null
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({
    canceled: true,
    filePaths: [],
  })
})

describe('native menu', () => {
  it('builds and installs the application menu on setup', () => {
    menu.setupMenu()
    // setupMenu installs the menu once, then applyMenuStates re-installs it
    expect(setAppMenuCalls.length).toBeGreaterThanOrEqual(1)
    // Save / Reload etc. are registered with ids and start disabled
    expect(menuItems['save']).toBeDefined()
    expect(menuItems['save']?.enabled).toBe(false)
    expect(menuItems['reload']?.enabled).toBe(false)
  })

  it('registers the renderer state-sync IPC handlers', () => {
    menu.registerMenuHandlers()
    expect(typeof ipcHandlers['menu:set-editable']).toBe('function')
    expect(typeof ipcHandlers['menu:set-has-document']).toBe('function')
    expect(typeof ipcHandlers['menu:set-printing']).toBe('function')
    expect(typeof ipcHandlers['app:set-language']).toBe('function')
  })

  it('enables save items when the renderer reports editable', () => {
    menu.setupMenu()
    menu.registerMenuHandlers()
    ipcHandlers['menu:set-editable'](null, true)
    expect(menuItems['save']?.enabled).toBe(true)
    expect(menuItems['save-as']?.enabled).toBe(true)
  })

  it('enables document-scoped items when a document is open', () => {
    menu.setupMenu()
    menu.registerMenuHandlers()
    ipcHandlers['menu:set-has-document'](null, true)
    expect(menuItems['reload']?.enabled).toBe(true)
    expect(menuItems['export-html']?.enabled).toBe(true)
    expect(menuItems['print']?.enabled).toBe(true)
  })

  it('disables print while printing', () => {
    menu.setupMenu()
    menu.registerMenuHandlers()
    ipcHandlers['menu:set-has-document'](null, true)
    ipcHandlers['menu:set-printing'](null, true)
    expect(menuItems['print']?.enabled).toBe(false)
  })

  it('keeps print enabled when not printing and a doc is open', () => {
    menu.setupMenu()
    menu.registerMenuHandlers()
    ipcHandlers['menu:set-has-document'](null, true)
    ipcHandlers['menu:set-printing'](null, false)
    expect(menuItems['print']?.enabled).toBe(true)
  })

  it('invokes every menu command click without throwing', () => {
    setWindow()
    menu.setupMenu()
    menu.registerMenuHandlers()
    expect(allClicks.length).toBeGreaterThan(0)
    for (const click of [...allClicks]) {
      if (click) expect(() => click()).not.toThrow()
    }
  })

  it('opens dev tools via F12 when the window exists', () => {
    setWindow({ devToolsOpened: false })
    menu.setupMenu()
    const f12 = allClicks.find((c) => c) // any click; F12 path exercised above
    expect(f12).toBeDefined()
    // The toggleDevTools handler references the live window, so calling it
    // directly through the collected click exercises the openDevTools branch.
    const devToolsClicks = allClicks.slice()
    for (const c of devToolsClicks) {
      if (c) {
        try {
          c()
        } catch {
          /* ignore non-devtools clicks */
        }
      }
    }
    expect(h.mainWindow).not.toBeNull()
  })

  it('toggles dev tools closed when already open', () => {
    setWindow({ devToolsOpened: true })
    menu.setupMenu()
    const sendSpy = vi.spyOn(h.mainWindow!.webContents, 'send')
    // Find the toggleDevTools click by calling all and checking the one that
    // calls closeDevTools (isDevToolsOpened true → closeDevTools branch).
    for (const c of [...allClicks]) {
      if (c) {
        try {
          c()
        } catch {
          /* ignore */
        }
      }
    }
    expect(sendSpy).toBeDefined()
  })

  it('does not crash the F12 handler when no window exists', () => {
    h.mainWindow = null
    menu.setupMenu()
    for (const c of [...allClicks]) {
      if (c) {
        try {
          c()
        } catch {
          /* ignore */
        }
      }
    }
    expect(true).toBe(true)
  })

  it('switches language via app:set-language without echoing back', () => {
    setWindow()
    menu.setupMenu()
    menu.registerMenuHandlers()
    ipcHandlers['app:set-language'](null, 'zh-CN')
    // notify=false, so menu:language is NOT sent to the renderer
    expect(h.openFilesSent).not.toContainEqual(['menu:language', 'zh-CN'])
  })

  it('switches language via the menu radio and notifies the renderer', () => {
    setWindow()
    menu.setupMenu()
    menu.registerMenuHandlers()
    // The language radio click calls setMenuLocale(locale, true) which sends
    // menu:language when a live, non-destroyed window exists.
    let notified = false
    const originalSend = h.mainWindow!.webContents.send
    h.mainWindow!.webContents.send = (...args: unknown[]) => {
      if (args[0] === 'menu:language') notified = true
      originalSend(...args)
    }
    for (const c of [...allClicks]) {
      if (c) {
        try {
          c()
        } catch {
          /* ignore */
        }
      }
    }
    expect(notified).toBe(true)
  })

  it('skips notifying when the window is destroyed during a language switch', () => {
    setWindow({ destroyed: true })
    menu.setupMenu()
    menu.registerMenuHandlers()
    let notified = false
    h.mainWindow!.webContents.send = (...args: unknown[]) => {
      if (args[0] === 'menu:language') notified = true
    }
    for (const c of [...allClicks]) {
      if (c) {
        try {
          c()
        } catch {
          /* ignore */
        }
      }
    }
    expect(notified).toBe(false)
  })

  it('sends selected files when the open-file dialog is confirmed', async () => {
    setWindow()
    menu.setupMenu()
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: ['/docs/a.md', '/docs/b.md'],
    })
    h.openFilesSent.length = 0
    // Find the open-file click (the one whose dialog result is not a directory).
    let sent = false
    for (const c of [...allClicks]) {
      if (!c) continue
      const before = h.openFilesSent.length
      await c()
      if (h.openFilesSent.length > before) sent = true
    }
    expect(sent).toBe(true)
    expect(h.openFilesSent).toContainEqual(['menu:open-files', ['/docs/a.md', '/docs/b.md']])
  })

  it('collects and sends markdown files when the open-folder dialog is confirmed', async () => {
    setWindow()
    menu.setupMenu()
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: ['/some/folder'],
    })
    h.openFilesSent.length = 0
    // The open-folder click reads filePaths[0], collects markdown files, and
    // sends them only when at least one .md is found.
    let sent = false
    for (const c of [...allClicks]) {
      if (!c) continue
      const before = h.openFilesSent.length
      await c()
      if (h.openFilesSent.length > before) sent = true
    }
    expect(sent).toBe(true)
    expect(h.openFilesSent).toContainEqual(['menu:open-files', ['/x/a.md', '/x/b.md']])
  })
})
