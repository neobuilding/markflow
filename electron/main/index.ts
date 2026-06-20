// electron/main/index.ts - MarkFlow main process (ESM)
import { app, shell, BrowserWindow, ipcMain, Menu, dialog, nativeTheme, session, screen } from 'electron'
import { join, dirname } from 'path'
import { pathToFileURL } from 'url'
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { registerDocumentHandlers } from './ipc/documents'
import { registerSearchHandlers } from './ipc/search'
import { initDatabase } from './db/database'

// __dirname is auto-injected by vite-plugin-electron/plugin esmShim()

// ─── Window bounds persistence ────────────────────────────────────
// Save & restore window position/size between launches.

function windowStateFile(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

interface WindowBounds {
  width: number
  height: number
  x: number
  y: number
  isMaximized?: boolean
}

function loadWindowBounds(): WindowBounds | null {
  try {
    const raw = readFileSync(windowStateFile(), 'utf-8')
    return JSON.parse(raw) as WindowBounds
  } catch {
    return null
  }
}

function saveWindowBounds(b: WindowBounds): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(windowStateFile(), JSON.stringify(b, null, 2), 'utf-8')
  } catch {
    // ignore — non-critical
  }
}

// In production, app.getAppPath() returns the path to the extracted asar
// (e.g. "D:\...\app.asar"), so joining dist-electron/dist/renderer works.
// In dev, we rely on Vite's VITE_DEV_SERVER_URL.
export const MAIN_DIST = join(app.getAppPath(), 'dist-electron')
export const RENDERER_DIST = join(app.getAppPath(), 'dist', 'renderer')
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'] ?? ''

process.env['APP_ROOT'] = join(app.getAppPath(), '..')

let mainWindow: BrowserWindow | null = null

// 设置 CSP：开发环境宽松（允许 Vite HMR + React Refresh 内联脚本），
// 生产环境严格（仅允许 self 资源）。
function setupCSP(): void {
  const isDev = !!VITE_DEV_SERVER_URL
  let policy: string
  if (isDev && VITE_DEV_SERVER_URL) {
    // 从 VITE_DEV_SERVER_URL 提取 origin（如 http://localhost:5174）
    let origin = 'http://localhost:5174'
    try {
      const u = new URL(VITE_DEV_SERVER_URL)
      origin = `${u.protocol}//${u.host}`
    } catch {
      // 保留默认值
    }
    const wsOrigin = origin.replace(/^http/, 'ws')
    policy = [
      `default-src 'self' ${origin}`,
      `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${origin}`,
      "style-src 'self' 'unsafe-inline'",
      `img-src 'self' data: blob: ${origin} https: http:`,
      "font-src 'self' data: blob:",
      `connect-src 'self' ${origin} ${wsOrigin}`,
    ].join('; ')
  } else {
    policy = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https: http:",
      "font-src 'self' data:",
      "img-src 'self' data:",
      "font-src 'self' data:",
    ].join('; ')
  }

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    })
  })
}

// 递归收集目录下所有 Markdown 文件
function collectMarkdownFiles(dir: string): string[] {
  const result: string[] = []
  const mdExts = new Set(['.md', '.markdown', '.mdx', '.mdtxt', '.mdtext'])
  try {
    const entries = readdirSync(dir)
    for (const name of entries) {
      // 跳过隐藏目录和 node_modules
      if (name.startsWith('.') || name === 'node_modules') continue
      const fullPath = join(dir, name)
      try {
        const st = statSync(fullPath)
        if (st.isDirectory()) {
          result.push(...collectMarkdownFiles(fullPath))
        } else if (st.isFile()) {
          const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
          if (mdExts.has(ext)) {
            result.push(fullPath)
          }
        }
      } catch {
        // 跳过无权限访问的文件
      }
    }
  } catch {
    // 跳过无权限访问的目录
  }
  return result
}

function createWindow(): void {
  const isDev = !!VITE_DEV_SERVER_URL

  // Get screen work area (excludes taskbar)
  const primaryDisplay = screen.getPrimaryDisplay()
  const workArea = primaryDisplay.workArea  // { x, y, width, height }

  // Restore last-used window bounds from disk if available, otherwise default
  // to a comfortable size: 92% of work area width, 92% of work area height.
  let winBounds: { width: number; height: number; x: number; y: number }
  let startMaximized = false
  const savedBounds = loadWindowBounds()
  if (savedBounds && savedBounds.width >= 800 && savedBounds.height >= 600) {
    winBounds = {
      width: Math.min(savedBounds.width, workArea.width),
      height: Math.min(savedBounds.height, workArea.height),
      x: Math.max(workArea.x, Math.min(savedBounds.x, workArea.x + workArea.width - savedBounds.width)),
      y: Math.max(workArea.y, Math.min(savedBounds.y, workArea.y + workArea.height - savedBounds.height)),
    }
    startMaximized = !!savedBounds.isMaximized
  } else {
    const w = Math.floor(workArea.width * 0.92)
    const h = Math.floor(workArea.height * 0.92)
    winBounds = {
      width: w,
      height: h,
      x: workArea.x + Math.floor((workArea.width - w) / 2),
      y: workArea.y + Math.floor((workArea.height - h) / 2),
    }
  }

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
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    if (startMaximized) {
      mainWindow?.maximize()
    }
    mainWindow?.show()
  })

  // Save window bounds when they change (resize / move / maximize-restore)
  const saveDebounced = (() => {
    let timer: NodeJS.Timeout | null = null
    return () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        if (mainWindow.isMaximized()) {
          saveWindowBounds({
            ...winBounds,
            isMaximized: true,
          })
        } else {
          const b = mainWindow.getBounds()
          saveWindowBounds({
            width: b.width,
            height: b.height,
            x: b.x,
            y: b.y,
            isMaximized: false,
          })
        }
      }, 500)
    }
  })()
  mainWindow.on('resize', saveDebounced)
  mainWindow.on('move', saveDebounced)
  mainWindow.on('maximize', saveDebounced)
  mainWindow.on('unmaximize', saveDebounced)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (isDev) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL)
    // DevTools 不自动打开，用户可通过 View 菜单或 F12 手动切换
  } else {
    // Use pathToFileURL to properly encode the path as a file:// URL.
    // loadFile() doesn't handle asar-embedded paths well, but loadURL(pathToFileURL(...))
    // gives Electron's Chromium renderer the correct file:// URL to load.
    const indexPath = join(RENDERER_DIST, 'index.html')
    mainWindow.loadURL(pathToFileURL(indexPath).href)
  }
}

function setupMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Document',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow?.webContents.send('menu:new-document'),
        },
        { type: 'separator' },
        {
          label: 'Open File...',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog({
              title: 'Open Markdown File',
              filters: [
                { name: 'Markdown', extensions: ['md', 'markdown', 'mdx', 'mdtxt', 'mdtext'] },
                { name: 'All Files', extensions: ['*'] },
              ],
              properties: ['openFile', 'multiSelections'],
            })
            if (!result.canceled && result.filePaths.length > 0) {
              mainWindow?.webContents.send('menu:open-files', result.filePaths)
            }
          },
        },
        {
          label: 'Open Folder...',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: async () => {
            const result = await dialog.showOpenDialog({
              title: 'Open Folder (batch import .md files)',
              properties: ['openDirectory'],
            })
            if (!result.canceled && result.filePaths.length > 0) {
              const folderPath = result.filePaths[0]
              // 递归收集所有 .md 文件
              const mdFiles = collectMarkdownFiles(folderPath)
              if (mdFiles.length > 0) {
                mainWindow?.webContents.send('menu:open-files', mdFiles)
              }
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow?.webContents.send('menu:save'),
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
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
      label: 'View',
      submenu: [
        {
          label: 'Toggle Sidebar',
          accelerator: 'CmdOrCtrl+\\',
          click: () => mainWindow?.webContents.send('menu:toggle-sidebar'),
        },
        {
          label: 'Toggle Preview',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => mainWindow?.webContents.send('menu:toggle-preview'),
        },
        {
          label: 'Fit Window to Content',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => mainWindow?.webContents.send('menu:fit-to-content'),
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: 'Toggle Developer Tools',
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
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }],
    },
  ]

  // Dev Tools 已合并到 View 菜单，无需独立 Dev 菜单

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId(app.isPackaged ? 'com.mark-flow.app' : process.execPath)
  }

  setupCSP()

  initDatabase(app)

  registerDocumentHandlers(ipcMain, app)
  registerSearchHandlers(ipcMain)

  ipcMain.handle('app:get-theme', () => nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  ipcMain.handle('app:set-theme', (_event, theme: 'light' | 'dark' | 'system') => {
    nativeTheme.themeSource = theme
  })

  // 让渲染层主动弹出文件选择对话框
  ipcMain.handle('dialog:open-files', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open Markdown File',
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown', 'mdx', 'mdtxt', 'mdtext'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile', 'multiSelections'],
    })
    return result.canceled ? [] : result.filePaths
  })

  // 让渲染层主动弹出文件夹选择对话框，返回该目录下所有 .md 文件
  ipcMain.handle('dialog:open-folder', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open Folder (batch import .md files)',
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return []
    return collectMarkdownFiles(result.filePaths[0])
  })

  // ─── Window: fit to content ────────────────────────────────────
  // Renderer measures the rendered content size (scrollWidth/scrollHeight)
  // and asks us to resize the window to fit. We clamp to the screen work area.
  ipcMain.handle('window:fit-to-content', (_event, contentWidth: number, contentHeight: number) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMaximized()) return  // don't fight the user if they maximized

    const workArea = screen.getPrimaryDisplay().workArea
    // Account for chrome (titlebar ~38px) + sidebar + padding overhead.
    // The renderer reports only the preview pane content size; we add frame.
    const TITLEBAR_H = 38
    const STATUSBAR_H = 24
    const PADDING = 48  // px-6 py-6 = 48px total horizontal/vertical padding
    const SIDEBAR_DEFAULT = 240

    // How wide does the window need to be?
    // = sidebar + editor/preview content + frame borders
    // For preview-only mode, just content + padding + frame.
    // We use the larger of: current width (so we never shrink below sidebar+editor)
    // or content-required width.
    const currentBounds = mainWindow.getBounds()
    const neededWidth = contentWidth + PADDING + SIDEBAR_DEFAULT + 20  // 20 = frame borders
    const neededHeight = contentHeight + TITLEBAR_H + STATUSBAR_H + PADDING + 20

    // Clamp to work area
    const newWidth = Math.min(Math.max(neededWidth, 800), workArea.width)
    const newHeight = Math.min(Math.max(neededHeight, 600), workArea.height)

    // Keep top-left anchored; shift left/up if we'd overflow the work area
    let newX = currentBounds.x
    let newY = currentBounds.y
    if (newX + newWidth > workArea.x + workArea.width) {
      newX = workArea.x + workArea.width - newWidth
    }
    if (newY + newHeight > workArea.y + workArea.height) {
      newY = workArea.y + workArea.height - newHeight
    }
    newX = Math.max(workArea.x, newX)
    newY = Math.max(workArea.y, newY)

    mainWindow.setBounds({ x: newX, y: newY, width: newWidth, height: newHeight })
  })

  ipcMain.handle('window:maximize', () => mainWindow?.maximize())
  ipcMain.handle('window:unmaximize', () => mainWindow?.unmaximize())
  ipcMain.handle('window:is-maximized', () => !!mainWindow?.isMaximized())

  createWindow()
  setupMenu()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
