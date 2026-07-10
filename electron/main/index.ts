// electron/main/index.ts - MarkFlow main process (ESM)
import { app, shell, BrowserWindow, ipcMain, Menu, dialog, nativeTheme, session, screen } from 'electron'
import { join, dirname, resolve } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import { readdirSync, statSync } from 'fs'
import { registerDocumentHandlers } from './ipc/documents'
import { registerSearchHandlers } from './ipc/search'
import { initDatabase } from './db/database'

// __dirname is auto-injected by vite-plugin-electron/plugin esmShim()

// ─── 运行时数据目录重定向到系统临时文件夹 ──────────────────────────
// 默认 Electron / Chromium 会把缓存、Local Storage、锁文件等写入
// AppData\Roaming\<app>，污染用户目录。这里把 userData 重定向到
// %TEMP%/markflow，使所有框架运行时数据都落在临时目录，随系统清理自动消失，
// 符合“业务数据不持久化”的隐私要求。
try {
  app.setPath('userData', join(tmpdir(), 'markflow'))
} catch {
  // 若设置失败（极少数情况），沿用默认路径
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
    // Electron 有时会用 127.0.0.1 而非 localhost 建立 HMR 连接，一并放行以避免遗漏
    let wsIp: string | undefined
    try {
      const u = new URL(origin)
      if (u.hostname === 'localhost') wsIp = `ws://127.0.0.1:${u.port}`
    } catch {
      // 忽略
    }
    policy = [
      `default-src 'self' ${origin}`,
      `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${origin}`,
      "style-src 'self' 'unsafe-inline'",
      `img-src 'self' data: blob: ${origin} https: http:`,
      "font-src 'self' data: blob:",
      `connect-src 'self' ${origin} ${wsOrigin}${wsIp ? ' ' + wsIp : ''}`,
    ].join('; ')
  } else {
    policy = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https: http:",
      "font-src 'self' data: blob:",
      "connect-src 'self'",
    ].join('; ')
  }

  // 关键修复：不要把我们的 CSP 应用到 Electron 的 DevTools / chrome 内部页面。
  // 否则 DevTools 前端无法连接其 CDP WebSocket（如 ws://127.0.0.1:<debug-port>），
  // 会在 DevTools console 报出 "Refused to connect ... CSP connect-src"、
  // "Autofill.enable wasn't found"、Failed to fetch 等一连串错误。
  const isInternalChromeUrl = (url: string): boolean =>
    /^(devtools|chrome-devtools|chrome|chrome-extension):\/\//.test(url)

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (isInternalChromeUrl(details.url)) {
      // 内部页面原样放行，不注入 CSP
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

// 支持的 Markdown 扩展名
const MD_EXTS = new Set(['.md', '.markdown', '.mdx', '.mdtxt', '.mdtext'])

// 递归收集目录下所有 Markdown 文件
function collectMarkdownFiles(dir: string): string[] {
  const result: string[] = []
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
          if (MD_EXTS.has(ext)) {
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

// 从命令行参数中提取需要打开的文件/文件夹路径
// （过滤掉 Electron 自身参数、脚本路径、dev server URL 等）
// 仅在打包模式下生效，开发模式中 process.argv 多为 Vite/Electron 内部参数，不应误处理。
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
      // 路径不存在则忽略
    }
  }
  return paths
}

// 启动时通过命令行传入、或 app 尚未就绪时由 open-file/second-instance 累积的路径
const pendingInitialPaths: string[] = extractArgvPaths(process.argv)

function createWindow(): void {
  const isDev = !!VITE_DEV_SERVER_URL

  // Get screen work area (excludes taskbar)
  const primaryDisplay = screen.getPrimaryDisplay()
  const workArea = primaryDisplay.workArea  // { x, y, width, height }

  // 窗口大小不持久化：启动时默认最大化。保留一个合理的初始尺寸，
  // 供用户取消最大化时作为还原尺寸使用。
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

  // 升级 Electron（30 → 43）后，旧的 userData（被重定向到 %TEMP%/markflow）
  // 中可能残留了非 100% 的缩放级别，导致整体界面（含所有边距）被缩小。
  // 每次加载完成后将缩放重置为默认级别，避免该残留 zoom 影响布局。
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.setZoomLevel(0)
  })
}

// 持有应用菜单引用，便于渲染层同步 editable 状态时动态启用/禁用 Save 菜单项。
let appMenu: Electron.Menu | null = null

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
          id: 'save',
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          enabled: false, // 默认只读，由渲染层同步 editable 后启用
          click: () => mainWindow?.webContents.send('menu:save'),
        },
        {
          id: 'save-as',
          label: 'Save As…',
          accelerator: 'CmdOrCtrl+Shift+S',
          enabled: false,
          click: () => mainWindow?.webContents.send('menu:save-as'),
        },
        {
          id: 'reload',
          label: 'Reload from Disk',
          accelerator: 'CmdOrCtrl+Shift+R',
          enabled: false, // 无打开文件时禁用，由渲染层同步状态启用
          click: () => mainWindow?.webContents.send('menu:reload'),
        },
        {
          id: 'file-details',
          label: 'File Details…',
          accelerator: 'CmdOrCtrl+I',
          enabled: false, // 无打开文件时禁用，由渲染层同步状态启用
          click: () => mainWindow?.webContents.send('menu:file-details'),
        },
        { type: 'separator' },
        {
          label: 'Close Workspace',
          accelerator: 'CmdOrCtrl+W',
          click: () => mainWindow?.webContents.send('menu:close-workspace'),
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
  appMenu = menu
  Menu.setApplicationMenu(menu)
}

// 渲染层同步 editable 状态：只读时禁用保存相关菜单项。
ipcMain.on('menu:set-editable', (_event, editable: boolean) => {
  if (!appMenu) return
  const saveItem = appMenu.getMenuItemById('save')
  const saveAsItem = appMenu.getMenuItemById('save-as')
  if (saveItem) saveItem.enabled = editable
  if (saveAsItem) saveAsItem.enabled = editable
  // 重新设置菜单以应用 enabled 变化（菜单项对象需重新挂载才刷新 UI）
  Menu.setApplicationMenu(appMenu)
})

// 渲染层同步“是否有打开文件”的状态：无文件时禁用 Reload / File Details。
ipcMain.on('menu:set-has-document', (_event, has: boolean) => {
  if (!appMenu) return
  const reloadItem = appMenu.getMenuItemById('reload')
  const detailsItem = appMenu.getMenuItemById('file-details')
  if (reloadItem) reloadItem.enabled = has
  if (detailsItem) detailsItem.enabled = has
  // 重新设置菜单以应用 enabled 变化（菜单项对象需重新挂载才刷新 UI）
  Menu.setApplicationMenu(appMenu)
})

// ─── Single instance + file/protocol open handling ───────────────
// 仅允许一个实例运行（作为 .md 关联程序时，重复打开会聚焦已有窗口）。
const shouldStart = app.isPackaged ? app.requestSingleInstanceLock() : true

// macOS：文件拖到 Dock 图标 / 在 Finder 中"打开方式"触发
app.on('open-file', (_event, filePath: string) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:open-paths', [filePath])
  } else {
    pendingInitialPaths.push(filePath)
  }
})

// Windows / Linux：关联程序双击文件、且应用已在运行时触发
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
  // 已有实例在运行，本实例退出（由已有实例处理打开请求）
  app.quit()
} else {
  app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId(app.isPackaged ? 'com.mark-flow.app' : process.execPath)
  }

  setupCSP()

  initDatabase(app)

  registerDocumentHandlers(ipcMain, app, () => mainWindow)
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

  // 让渲染层主动弹出文件夹选择对话框，仅返回所选文件夹路径
  ipcMain.handle('dialog:select-folder', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open Folder',
      properties: ['openDirectory'],
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // 让渲染层主动弹出“另存为”对话框，返回用户选择的路径（取消则返回 null）
  ipcMain.handle('dialog:save-file', async (_event, defaultPath?: string) => {
    const result = await dialog.showSaveDialog({
      title: 'Save As',
      defaultPath,
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown', 'mdx', 'mdtxt', 'mdtext'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    return result.canceled ? null : result.filePath ?? null
  })

  // 解析一组拖入/传入的路径：将文件夹展开为其内所有 .md 文件，
  // 文件则按扩展名过滤，最终返回去重后的目录列表与 Markdown 文件列表。
  // 渲染层据此一次性导入并设置"当前文件夹"。
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
            // 打开单个文件时，同时将其所在目录下所有 .md 文件一并导入，
            // 使侧栏能展示同目录的其它文档（而非只显示当前打开的那一个）。
            const parentDir = dirname(absolute)
            if (!directories.includes(parentDir)) {
              directories.push(parentDir)
            }
            for (const f of collectMarkdownFiles(parentDir)) markdownFiles.add(f)
          }
        }
      } catch {
        // 跳过无法访问的路径
      }
    }
    return { directories, markdownFiles: [...markdownFiles] }
  })

  // 渲染层启动后主动拉取启动阶段累积的待打开路径（命令行参数等）
  ipcMain.handle('app:get-initial-paths', () => {
    const paths = pendingInitialPaths.splice(0, pendingInitialPaths.length)
    return paths
  })

  // 在系统文件管理器中定位并高亮指定文件
  ipcMain.handle('app:show-in-folder', (_event, filePath: string) => {
    try {
      shell.showItemInFolder(filePath)
    } catch {
      // 忽略：文件可能不存在或无权限
    }
  })

  // ─── Window control ────────────────────────────────────────────

  ipcMain.handle('window:maximize', () => mainWindow?.maximize())
  ipcMain.handle('window:unmaximize', () => mainWindow?.unmaximize())
  ipcMain.handle('window:is-maximized', () => !!mainWindow?.isMaximized())

  createWindow()
  setupMenu()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
