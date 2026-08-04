// electron/main/index.ts - MarkFlow main process (ESM)
import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  Menu,
  dialog,
  nativeTheme,
  session,
  screen,
  protocol,
} from 'electron'
import { join, dirname, resolve, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { registerDocumentHandlers } from './ipc/documents'
import { registerSearchHandlers } from './ipc/search'
import { registerExportHandlers } from './ipc/export'
import { initDatabase, getDb } from './db/database'
import { isSubdir, APPDOC_MIME, parseAppDocUrl } from './lib/security'
import { MenuLocale, getCurrentLocale, menuT, setMenuLanguage, initMenuI18n } from './i18n'

// __dirname is auto-injected by vite-plugin-electron/plugin esmShim()

// ─── Redirect runtime data directory to the system temp folder ──────────────
// By default Electron / Chromium write caches, Local Storage, lock files, etc. into
// AppData\Roaming\<app>, polluting the user directory. Here we redirect userData to
// %TEMP%/markflow so all framework runtime data lands in the temp directory and is
// cleaned up automatically with the system, satisfying the "no business-data persistence"
// privacy requirement.
try {
  app.setPath('userData', join(tmpdir(), 'markflow'))
} catch {
  // If setting fails (rare), fall back to the default path
}

// ─── appdoc: privileged protocol registration (must be at module top level, before
//     app.ready, C2/C3) ───
// ① registerSchemesAsPrivileged must be called at module top level before app.ready,
//   otherwise it throws at runtime; bypassCSP:false is written explicitly so we don't
//   weaken the CSP backstop.
// ② protocol.handle('appdoc', ...) is registered inside the app.whenReady callback
//   (see registerAppDocProtocol).
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'appdoc',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: false,
    },
  },
])

// In production, app.getAppPath() returns the path to the extracted asar
// (e.g. "D:\...\app.asar"), so joining dist-electron/dist/renderer works.
// In dev, we rely on Vite's VITE_DEV_SERVER_URL.
export const MAIN_DIST = join(app.getAppPath(), 'dist-electron')
export const RENDERER_DIST = join(app.getAppPath(), 'dist', 'renderer')
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'] ?? ''

process.env['APP_ROOT'] = join(app.getAppPath(), '..')

let mainWindow: BrowserWindow | null = null

// Configure CSP: permissive in dev (allows Vite HMR + React Refresh inline scripts),
// strict in production (only self-origin resources allowed).
function setupCSP(): void {
  const isDev = !!VITE_DEV_SERVER_URL
  let policy: string
  if (isDev && VITE_DEV_SERVER_URL) {
    // Derive the origin from VITE_DEV_SERVER_URL (e.g. http://localhost:5174)
    let origin = 'http://localhost:5174'
    try {
      const u = new URL(VITE_DEV_SERVER_URL)
      origin = `${u.protocol}//${u.host}`
    } catch {
      // Keep the default
    }
    const wsOrigin = origin.replace(/^http/, 'ws')
    // Electron sometimes uses 127.0.0.1 instead of localhost for the HMR connection;
    // allow both so we don't miss it.
    let wsIp: string | undefined
    try {
      const u = new URL(origin)
      if (u.hostname === 'localhost') wsIp = `ws://127.0.0.1:${u.port}`
    } catch {
      // Ignore
    }
    policy = [
      `default-src 'self' ${origin}`,
      `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${origin}`,
      "style-src 'self' 'unsafe-inline'",
      `img-src 'self' data: ${origin} https: appdoc:`,
      "font-src 'self' data:",
      `connect-src 'self' ${origin} ${wsOrigin}${wsIp ? ' ' + wsIp : ''}`,
    ].join('; ')
  } else {
    policy = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https: appdoc:",
      "font-src 'self' data:",
      "connect-src 'self'",
    ].join('; ')
  }

  // Critical fix: do not apply our CSP to Electron's DevTools / chrome internal pages.
  // Otherwise the DevTools frontend can't connect to its CDP WebSocket (e.g.
  // ws://127.0.0.1:<debug-port>), producing a cascade of errors in the DevTools console
  // like "Refused to connect ... CSP connect-src", "Autofill.enable wasn't found",
  // and Failed to fetch.
  const isInternalChromeUrl = (url: string): boolean =>
    /^(devtools|chrome-devtools|chrome|chrome-extension):\/\//.test(url)

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (isInternalChromeUrl(details.url)) {
      // Let internal pages through as-is, without injecting CSP
      callback({ responseHeaders: details.responseHeaders })
      return
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    })
  })
}

// ─── appdoc: protocol handling (privilege / symlink allow-list, C2 / §4.1 / §4.5) ───
// URL shape: appdoc://<docId>/<relativePath>. The handler looks up file_path by docId
// in the DB, computes docBaseDir, resolves the relative path to an absolute one, then
// runs the secondary containment check; any privilege escape returns 403.
// APPDOC_MIME / isSubdir are defined in ./lib/security (shared with other main-process handlers).
function registerAppDocProtocol(): void {
  protocol.handle('appdoc', (request) => {
    try {
      // appdoc://<docId>/<relativePath>: docId is in the hostname and the relative path
      // needs percent-decoding; delegate to parseAppDocUrl (see ./lib/security) to avoid
      // drifting from the export inline logic.
      const parsed = parseAppDocUrl(request.url)
      if (!parsed) {
        return new Response('Not Found', { status: 404 })
      }
      const { docId, relPath } = parsed
      const row = getDb().prepare('SELECT file_path FROM documents WHERE id = ?').get(docId) as
        { file_path: string } | undefined
      if (!row?.file_path) {
        return new Response('Not Found', { status: 404 })
      }
      const docBaseDir = dirname(row.file_path)
      const resolved = resolve(docBaseDir, relPath)
      // Secondary containment check: block ../ traversal and symlink escapes
      if (!isSubdir(docBaseDir, resolved)) {
        return new Response('Forbidden', { status: 403 })
      }
      if (!existsSync(resolved)) {
        return new Response('Not Found', { status: 404 })
      }
      const data = readFileSync(resolved)
      const mime = APPDOC_MIME[extname(resolved).toLowerCase()] ?? 'application/octet-stream'
      return new Response(data, {
        headers: {
          'Content-Type': mime,
          // Images must not be readable by any page script, so tighten CSP
          'Content-Security-Policy': "default-src 'none'",
        },
      })
    } catch {
      return new Response('Error', { status: 500 })
    }
  })
}

// Supported Markdown extensions
const MD_EXTS = new Set(['.md', '.markdown', '.mdx', '.mdtxt', '.mdtext'])

// Recursively collect all Markdown files under a directory
function collectMarkdownFiles(dir: string): string[] {
  const result: string[] = []
  try {
    const entries = readdirSync(dir)
    for (const name of entries) {
      // Skip hidden directories and node_modules
      if (name.startsWith('.') || name === 'node_modules') continue
      const fullPath = join(dir, name)
      try {
        const st = statSync(fullPath)
        if (st.isDirectory()) {
          result.push(...collectMarkdownFiles(fullPath))
        } else if (st.isFile()) {
          const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
          if (MD_EXTS.has(ext)) {
            result.push(fullPath)
          }
        }
      } catch {
        // Skip files we can't access
      }
    }
  } catch {
    // Skip directories we can't access
  }
  return result
}

// Extract file/folder paths to open from command-line arguments
// (filtering out Electron's own args, script paths, dev server URLs, etc.).
// Only active in packaged mode; in dev, process.argv is mostly Vite/Electron internal
// args and should not be handled here.
function extractArgvPaths(argv: string[]): string[] {
  if (!app.isPackaged) return []
  const paths: string[] = []
  for (const arg of argv) {
    if (arg.startsWith('-') || arg.startsWith('http')) continue
    if (arg.endsWith('.js') || arg.endsWith('.ts') || arg.endsWith('.cjs')) continue
    try {
      const absolute = resolve(arg)
      const st = statSync(absolute)
      if (st.isDirectory()) {
        paths.push(absolute)
      } else if (st.isFile()) {
        const ext = arg.slice(arg.lastIndexOf('.')).toLowerCase()
        if (MD_EXTS.has(ext)) paths.push(absolute)
      }
    } catch {
      // Ignore paths that don't exist
    }
  }
  return paths
}

// Paths passed via CLI at launch, or accumulated from open-file/second-instance before
// the app is ready
const pendingInitialPaths: string[] = extractArgvPaths(process.argv)

function createWindow(): void {
  const isDev = !!VITE_DEV_SERVER_URL

  // Get screen work area (excludes taskbar)
  const primaryDisplay = screen.getPrimaryDisplay()
  const workArea = primaryDisplay.workArea // { x, y, width, height }

  // Window size is not persisted: start maximized by default. Keep a sensible initial
  // size to use as the restore size when the user un-maximizes.
  const w = Math.floor(workArea.width * 0.92)
  const h = Math.floor(workArea.height * 0.92)
  const winBounds = {
    width: w,
    height: h,
    x: workArea.x + Math.floor((workArea.width - w) / 2),
    y: workArea.y + Math.floor((workArea.height - h) / 2),
  }
  const startMaximized = true

  mainWindow = new BrowserWindow({
    width: winBounds.width,
    height: winBounds.height,
    x: winBounds.x,
    y: winBounds.y,
    minWidth: 800,
    minHeight: 600,
    show: false,
    frame: process.platform !== 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#f7f7f7',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      sandbox: true, // Security gate (P0): even sandboxed, preload still has a polyfilled require (see §4.1 / R9)
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    if (startMaximized) {
      mainWindow?.maximize()
    }
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (isDev) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL)
    // DevTools is not opened automatically; the user can toggle it via the View menu or F12
  } else {
    // Use pathToFileURL to properly encode the path as a file:// URL.
    // loadFile() doesn't handle asar-embedded paths well, but loadURL(pathToFileURL(...))
    // gives Electron's Chromium renderer the correct file:// URL to load.
    const indexPath = join(RENDERER_DIST, 'index.html')
    mainWindow.loadURL(pathToFileURL(indexPath).href)
  }

  // After upgrading Electron (30 → 43), the old userData (redirected to %TEMP%/markflow)
  // may retain a non-100% zoom level that shrinks the whole UI (including all margins).
  // Reset the zoom to the default level after each load so the leftover zoom can't affect layout.
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.setZoomLevel(0)
  })

  // Intercept the *window* close (red X / traffic-light close) so it runs the SAME
  // unsaved prompt as quitting — never destroys a window with unsaved changes silently.
  // Only once the renderer replies with app:quit-allowed do we set isQuiting and let the
  // close proceed. This guarantees the prompt always happens while the window is alive,
  // eliminating the race where before-quit fires after the window is already destroyed.
  const win = mainWindow
  win.on('close', (event) => {
    if (isQuiting) return
    event.preventDefault()
    win.webContents.send('app:request-quit')
  })
}

// ─── UI language (i18n) for the native menu ──────────────────────────────
// The renderer's in-app UI and this native menu share the SAME i18next
// dictionaries (see ./i18n). English is the fallback. The MenuLocale type,
// getCurrentLocale(), menuT(), and setMenuLanguage() live in ./i18n and are
// wired to the shared dictionaries in shared/i18n/{en,zh-CN}.ts.

// Switch the active menu locale, rebuild the menu, and (optionally) notify the
// renderer so its in-app UI stays in sync. notify=false is used for renderer-
// driven changes (initial sync / reacting to the menu) to avoid an echo loop.
function setMenuLocale(locale: MenuLocale, notify: boolean): void {
  setMenuLanguage(locale)
  setupMenu()
  if (notify && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('menu:language', locale)
  }
}

// Hold a reference to the app menu so the renderer can dynamically enable/disable the Save
// menu item when it syncs the editable state.
let appMenu: Electron.Menu | null = null

// Renderer-synced states that govern which menu items are enabled. They are kept at module
// scope so that rebuilding the menu (e.g. on a language switch) can re-apply them instead of
// resetting every item back to its disabled default.
let editableState = false
let hasDocumentState = false
let printingState = false

// Re-apply the renderer-synced states to the current menu so that a menu rebuild (such as a
// language switch via setupMenu()) preserves the enabled/disabled state the renderer last sent.
function applyMenuStates(): void {
  if (!appMenu) return
  const saveItem = appMenu.getMenuItemById('save')
  const saveAsItem = appMenu.getMenuItemById('save-as')
  const reloadItem = appMenu.getMenuItemById('reload')
  const detailsItem = appMenu.getMenuItemById('file-details')
  const exportItem = appMenu.getMenuItemById('export-html')
  const printItem = appMenu.getMenuItemById('print')
  const closeFileItem = appMenu.getMenuItemById('close-file')
  if (saveItem) saveItem.enabled = editableState
  if (saveAsItem) saveAsItem.enabled = editableState
  if (reloadItem) reloadItem.enabled = hasDocumentState
  if (detailsItem) detailsItem.enabled = hasDocumentState
  if (exportItem) exportItem.enabled = hasDocumentState
  if (printItem) printItem.enabled = hasDocumentState && !printingState
  if (closeFileItem) closeFileItem.enabled = hasDocumentState
  Menu.setApplicationMenu(appMenu)
}

function setupMenu(): void {
  // Menu labels resolve per key via menuT(...) below.
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: menuT('menu.file'),
      submenu: [
        {
          label: menuT('menu.newDocument'),
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow?.webContents.send('menu:new-document'),
        },
        { type: 'separator' },
        {
          label: menuT('menu.openFile'),
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog({
              title: menuT('menu.dlgOpenFile'),
              filters: [
                {
                  name: menuT('menu.filterMarkdown'),
                  extensions: ['md', 'markdown', 'mdx', 'mdtxt', 'mdtext'],
                },
                { name: menuT('menu.filterAllFiles'), extensions: ['*'] },
              ],
              properties: ['openFile', 'multiSelections'],
            })
            if (!result.canceled && result.filePaths.length > 0) {
              mainWindow?.webContents.send('menu:open-files', result.filePaths)
            }
          },
        },
        {
          label: menuT('menu.openFolder'),
          accelerator: 'CmdOrCtrl+Shift+O',
          click: async () => {
            const result = await dialog.showOpenDialog({
              title: menuT('menu.dlgOpenFolder'),
              properties: ['openDirectory'],
            })
            if (!result.canceled && result.filePaths.length > 0) {
              const folderPath = result.filePaths[0]
              // Recursively collect all .md files
              const mdFiles = collectMarkdownFiles(folderPath)
              if (mdFiles.length > 0) {
                mainWindow?.webContents.send('menu:open-files', mdFiles)
              }
            }
          },
        },
        { type: 'separator' },
        {
          id: 'save',
          label: menuT('menu.save'),
          accelerator: 'CmdOrCtrl+S',
          enabled: false, // Read-only by default; enabled by the renderer once it syncs the editable state
          click: () => mainWindow?.webContents.send('menu:save'),
        },
        {
          id: 'save-as',
          label: menuT('menu.saveAs'),
          accelerator: 'CmdOrCtrl+Shift+S',
          enabled: false,
          click: () => mainWindow?.webContents.send('menu:save-as'),
        },
        {
          id: 'reload',
          label: menuT('menu.reload'),
          accelerator: 'CmdOrCtrl+Shift+R',
          enabled: false, // Disabled when no file is open; enabled by the renderer's synced state
          click: () => mainWindow?.webContents.send('menu:reload'),
        },
        {
          id: 'file-details',
          label: menuT('menu.fileDetails'),
          accelerator: 'CmdOrCtrl+I',
          enabled: false, // Disabled when no file is open; enabled by the renderer's synced state
          click: () => mainWindow?.webContents.send('menu:file-details'),
        },
        {
          id: 'export-html',
          label: menuT('menu.exportHtml'),
          accelerator: 'CmdOrCtrl+Shift+E',
          enabled: false, // Disabled when no file is open; enabled by the renderer's synced state
          click: () => mainWindow?.webContents.send('menu:export-html'),
        },
        {
          id: 'print',
          label: menuT('menu.print'),
          accelerator: 'CmdOrCtrl+P',
          enabled: false, // Disabled when no file is open; enabled by the renderer's synced state
          click: () => mainWindow?.webContents.send('menu:print'),
        },
        { type: 'separator' },
        {
          id: 'close-file',
          label: menuT('menu.closeFile'),
          accelerator: 'CmdOrCtrl+W',
          enabled: false, // Disabled when no file is open; enabled by the renderer's synced state
          click: () => mainWindow?.webContents.send('menu:close-file'),
        },
        {
          id: 'close-workspace',
          label: menuT('menu.closeWorkspace'),
          accelerator: 'CmdOrCtrl+Shift+W',
          click: () => mainWindow?.webContents.send('menu:close-workspace'),
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: menuT('menu.edit'),
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: menuT('menu.view'),
      submenu: [
        {
          label: menuT('menu.toggleSidebar'),
          accelerator: 'CmdOrCtrl+\\',
          click: () => mainWindow?.webContents.send('menu:toggle-sidebar'),
        },
        {
          label: menuT('menu.togglePreview'),
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => mainWindow?.webContents.send('menu:toggle-preview'),
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: menuT('menu.toggleDevTools'),
          accelerator: 'F12',
          click: () => {
            const wc = mainWindow?.webContents
            if (!wc) return
            if (wc.isDevToolsOpened()) {
              wc.closeDevTools()
            } else {
              wc.openDevTools({ mode: 'detach' })
            }
          },
        },
      ],
    },
    {
      label: menuT('menu.window'),
      submenu: [{ role: 'minimize' }, { role: 'zoom' }],
    },
    {
      label: menuT('menu.help'),
      submenu: [
        {
          label: menuT('menu.about'),
          click: () => mainWindow?.webContents.send('menu:about'),
        },
      ],
    },
    {
      label: menuT('menu.language'),
      submenu: [
        {
          label: menuT('menu.english'),
          type: 'radio',
          checked: getCurrentLocale() === 'en',
          click: () => setMenuLocale('en', true),
        },
        {
          label: menuT('menu.chinese'),
          type: 'radio',
          checked: getCurrentLocale() === 'zh-CN',
          click: () => setMenuLocale('zh-CN', true),
        },
      ],
    },
  ]

  // Dev Tools is merged into the View menu; no separate Dev menu needed

  const menu = Menu.buildFromTemplate(template)
  appMenu = menu
  Menu.setApplicationMenu(menu)
  // Re-apply renderer-synced states so a menu rebuild (e.g. on language switch) keeps the
  // enabled/disabled state the renderer last sent instead of resetting everything to disabled.
  applyMenuStates()
}

// Renderer syncs the editable state: disable save-related menu items while read-only.
ipcMain.on('menu:set-editable', (_event, editable: boolean) => {
  editableState = editable
  applyMenuStates()
})

// Renderer-synced "has open document" state: disable Reload / File Details / Export / Print
// when no document is open.
ipcMain.on('menu:set-has-document', (_event, has: boolean) => {
  hasDocumentState = has
  applyMenuStates()
})

// Disable the Print menu item during printing to avoid the user triggering it repeatedly.
ipcMain.on('menu:set-printing', (_event, printing: boolean) => {
  printingState = printing
  applyMenuStates()
})

// ─── Single instance + file/protocol open handling ───────────────
// Only one instance may run (when used as the .md handler, reopening focuses the existing window).
const shouldStart = app.isPackaged ? app.requestSingleInstanceLock() : true

// macOS: triggered when a file is dropped on the Dock icon or opened via "Open With" in Finder
app.on('open-file', (_event, filePath: string) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:open-paths', [filePath])
  } else {
    pendingInitialPaths.push(filePath)
  }
})

// Windows / Linux: triggered when the associated app is double-clicked while already running
app.on('second-instance', (_event, argv: string[]) => {
  const paths = extractArgvPaths(argv)
  if (paths.length === 0) return
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    mainWindow.webContents.send('app:open-paths', paths)
  } else {
    pendingInitialPaths.push(...paths)
  }
})

if (!shouldStart) {
  // Another instance is already running; quit this one (the existing instance handles the open request)
  app.quit()
} else {
  app.whenReady().then(() => {
    if (process.platform === 'win32') {
      app.setAppUserModelId(app.isPackaged ? 'com.mark-flow.app' : process.execPath)
    }

    setupCSP()

    initDatabase()

    // appdoc: protocol handling (must be registered inside whenReady; ② and
    // registerSchemesAsPrivileged happen at two different times)
    registerAppDocProtocol()

    // Deny all permission requests: a Markdown reader needs no camera/microphone/geolocation
    // permissions (§4.1)
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false)
    })

    registerDocumentHandlers(ipcMain, app, () => mainWindow)
    registerSearchHandlers(ipcMain)
    registerExportHandlers(ipcMain)

    ipcMain.handle('app:get-theme', () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'))
    ipcMain.handle('app:set-theme', (_event, theme: 'light' | 'dark' | 'system') => {
      nativeTheme.themeSource = theme
    })

    // Let the renderer proactively open a file-picker dialog
    ipcMain.handle('dialog:open-files', async () => {
      const result = await dialog.showOpenDialog({
        title: menuT('menu.dlgOpenFile'),
        filters: [
          {
            name: menuT('menu.filterMarkdown'),
            extensions: ['md', 'markdown', 'mdx', 'mdtxt', 'mdtext'],
          },
          { name: menuT('menu.filterAllFiles'), extensions: ['*'] },
        ],
        properties: ['openFile', 'multiSelections'],
      })
      return result.canceled ? [] : result.filePaths
    })

    // Let the renderer proactively open a folder-picker dialog, returning all .md files under it
    ipcMain.handle('dialog:open-folder', async () => {
      const result = await dialog.showOpenDialog({
        title: menuT('menu.dlgOpenFolder'),
        properties: ['openDirectory'],
      })
      if (result.canceled || result.filePaths.length === 0) return []
      return collectMarkdownFiles(result.filePaths[0])
    })

    // Let the renderer proactively open a folder-picker dialog, returning only the chosen folder path
    ipcMain.handle('dialog:select-folder', async () => {
      const result = await dialog.showOpenDialog({
        title: menuT('menu.openFolder'),
        properties: ['openDirectory'],
      })
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    })

    // Let the renderer proactively open a "Save As" dialog, returning the chosen path (null if canceled)
    ipcMain.handle('dialog:save-file', async (_event, defaultPath?: string) => {
      const result = await dialog.showSaveDialog({
        title: menuT('menu.saveAs'),
        defaultPath,
        filters: [
          {
            name: menuT('menu.filterMarkdown'),
            extensions: ['md', 'markdown', 'mdx', 'mdtxt', 'mdtext'],
          },
          { name: menuT('menu.filterAllFiles'), extensions: ['*'] },
        ],
      })
      return result.canceled ? null : (result.filePath ?? null)
    })

    // Let the renderer proactively open an "Export as HTML" dialog (R7) with .html filter by default.
    ipcMain.handle('dialog:save-html', async (_event, defaultPath?: string) => {
      const result = await dialog.showSaveDialog({
        title: menuT('menu.exportHtml'),
        defaultPath,
        filters: [
          { name: menuT('menu.filterHtml'), extensions: ['html', 'htm'] },
          { name: menuT('menu.filterAllFiles'), extensions: ['*'] },
        ],
      })
      return result.canceled ? null : (result.filePath ?? null)
    })

    // Resolve a set of dropped/passed paths: expand folders into all their .md files,
    // filter files by extension, and return de-duplicated directory and Markdown file lists.
    // The renderer uses this to import in one shot and set the "current folder".
    ipcMain.handle('files:resolve-paths', (_event, paths: string[]) => {
      const directories: string[] = []
      const markdownFiles = new Set<string>()
      for (const p of paths) {
        try {
          const absolute = resolve(p)
          const st = statSync(absolute)
          if (st.isDirectory()) {
            directories.push(absolute)
            for (const f of collectMarkdownFiles(absolute)) markdownFiles.add(f)
          } else if (st.isFile()) {
            const ext = absolute.slice(absolute.lastIndexOf('.')).toLowerCase()
            if (MD_EXTS.has(ext)) {
              markdownFiles.add(absolute)
              // When opening a single file, also import every .md file in its directory so the
              // sidebar shows sibling documents (not just the one currently open).
              const parentDir = dirname(absolute)
              if (!directories.includes(parentDir)) {
                directories.push(parentDir)
              }
              for (const f of collectMarkdownFiles(parentDir)) markdownFiles.add(f)
            }
          }
        } catch {
          // Skip paths we can't access
        }
      }
      return { directories, markdownFiles: [...markdownFiles] }
    })

    // After the renderer starts, proactively pull the pending open paths accumulated at launch (CLI args, etc.)
    ipcMain.handle('app:get-initial-paths', () => {
      const paths = pendingInitialPaths.splice(0, pendingInitialPaths.length)
      return paths
    })

    // Locate and highlight the given file in the system file manager
    ipcMain.handle('app:show-in-folder', (_event, filePath: string) => {
      try {
        shell.showItemInFolder(filePath)
      } catch {
        // Ignore: the file may not exist or we lack permission
      }
    })

    // Renderer's "About" dialog fetches the app version (in production this is the injected rolling version)
    ipcMain.handle('app:get-version', () => app.getVersion())

    // Renderer sends its (persisted or system) UI language so the native menu matches.
    // notify=false: we must not echo back to the renderer here, or we'd create a sync loop
    // (renderer → main → menu:language → renderer → main → ...).
    ipcMain.on('app:set-language', (_event, locale: 'en' | 'zh-CN') => {
      if (locale === 'en' || locale === 'zh-CN') setMenuLocale(locale, false)
    })

    // ─── Window control ────────────────────────────────────────────

    ipcMain.handle('window:maximize', () => mainWindow?.maximize())
    ipcMain.handle('window:unmaximize', () => mainWindow?.unmaximize())
    ipcMain.handle('window:is-maximized', () => !!mainWindow?.isMaximized())

    initMenuI18n()
    createWindow()
    setupMenu()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        // Defensive reset: if a future change makes closing the window keep the
        // process alive (macOS-style), a rebuilt window must not inherit the stale
        // quitting flags or it would skip the unsaved-changes prompt on next close.
        isQuiting = false
        readyToQuit = false
        createWindow()
      }
    })
  })
}

// ─── Quit flow reuses the "close workspace" prompt (PLAN §6.5) ───────────────
// Quitting the whole app must behave EXACTLY like closing a file / workspace: the
// renderer runs the same unified unsaved-changes prompt. So on `before-quit` we ask
// the renderer to close the workspace; only once it replies (app:quit-allowed) do we
// proceed. If the user cancels the prompt, the renderer simply doesn't reply and the
// quit stays aborted. New (memory-only) documents and edits to existing files are
// treated identically — no special quit prompt. Memory-only drafts (empty file_path)
// are purged as a safety net so they never survive a restart, but only after the
// renderer has already run its prompt (never silently discarded).
let readyToQuit = false
// Whether the app is actively quitting. Set once the renderer has confirmed the
// unsaved-changes prompt, so the window 'close' handler and 'before-quit' let the
// teardown proceed instead of re-prompting.
let isQuiting = false

function purgeUnsavedDrafts(): void {
  try {
    getDb()
      .prepare("DELETE FROM documents WHERE file_path IS NULL OR file_path = ''")
      .run()
  } catch {
    // Best-effort cleanup; the DB is in-memory so nothing persists regardless.
  }
}

ipcMain.on('app:quit-allowed', () => {
  // The renderer has run the unified unsaved prompt and the user confirmed (or there
  // were no unsaved changes). Mark the app as quitting and quit for real; 'before-quit'
  // will then purge and let the teardown proceed. Using app.quit() (not mainWindow.close)
  // makes closing the window and quitting the app behave identically on every platform,
  // including macOS where close() alone would only hide the window and keep the process.
  isQuiting = true
  readyToQuit = true
  app.quit()
})

app.on('before-quit', (event) => {
  if (readyToQuit) {
    purgeUnsavedDrafts()
    return
  }
  // Fallback for quit paths that bypass the window 'close' handler (e.g. macOS
  // Cmd+Q / dock Quit, or a quit request with no live window). Ask the renderer to
  // run the unified prompt; only intercept while a window can actually show it.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:request-quit')
    event.preventDefault()
  }
})

app.on('window-all-closed', () => {
  // Quit on all platforms once the last window is closed. Combined with app.quit() in
  // app:quit-allowed, closing the window and quitting the app are identical everywhere
  // (including macOS, where the default is to keep the process alive in the dock).
  app.quit()
})
