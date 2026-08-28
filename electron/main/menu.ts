// Native menu for the main process. Extracted from index.ts.
//
// Holds the menu template / state, builds the menu, and registers the menu IPC
// handlers. All `mainWindow` references go through getMainWindow() (from state.ts)
// because the window instance is no longer a module-level variable here.
import { ipcMain, Menu, dialog } from 'electron'
import { getMainWindow } from './state'
import { menuT, getCurrentLocale, setMenuLanguage, type MenuLocale } from './i18n'
import { collectMarkdownFiles } from './lib/md-files'

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
  if (notify) {
    const mw = getMainWindow()
    if (mw && !mw.isDestroyed()) {
      mw.webContents.send('menu:language', locale)
    }
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

export function setupMenu(): void {
  // Menu labels resolve per key via menuT(...) below.
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: menuT('menu.file'),
      submenu: [
        {
          label: menuT('menu.newDocument'),
          accelerator: 'CmdOrCtrl+N',
          click: () => getMainWindow()?.webContents.send('menu:new-document'),
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
              getMainWindow()?.webContents.send('menu:open-files', result.filePaths)
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
                // Send the *folder*, not the expanded file list: the renderer expands
                // folders itself (files:resolve-paths), and only the folder path lets it
                // pin `activeFolder` — and therefore the watched root — to the directory
                // the user actually chose. Sending the file list made the renderer fall
                // back to the parent directory of whichever file happened to be listed
                // first, which is a subdirectory whenever the picked folder has no .md
                // files at its top level.
                getMainWindow()?.webContents.send('menu:open-files', [folderPath])
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
          click: () => getMainWindow()?.webContents.send('menu:save'),
        },
        {
          id: 'save-as',
          label: menuT('menu.saveAs'),
          accelerator: 'CmdOrCtrl+Shift+S',
          enabled: false,
          click: () => getMainWindow()?.webContents.send('menu:save-as'),
        },
        {
          id: 'reload',
          label: menuT('menu.reload'),
          accelerator: 'CmdOrCtrl+Shift+R',
          enabled: false, // Disabled when no file is open; enabled by the renderer's synced state
          click: () => getMainWindow()?.webContents.send('menu:reload'),
        },
        {
          id: 'file-details',
          label: menuT('menu.fileDetails'),
          accelerator: 'CmdOrCtrl+I',
          enabled: false, // Disabled when no file is open; enabled by the renderer's synced state
          click: () => getMainWindow()?.webContents.send('menu:file-details'),
        },
        {
          id: 'export-html',
          label: menuT('menu.exportHtml'),
          accelerator: 'CmdOrCtrl+Shift+E',
          enabled: false, // Disabled when no file is open; enabled by the renderer's synced state
          click: () => getMainWindow()?.webContents.send('menu:export-html'),
        },
        {
          id: 'print',
          label: menuT('menu.print'),
          accelerator: 'CmdOrCtrl+P',
          enabled: false, // Disabled when no file is open; enabled by the renderer's synced state
          click: () => getMainWindow()?.webContents.send('menu:print'),
        },
        { type: 'separator' },
        {
          id: 'close-file',
          label: menuT('menu.closeFile'),
          accelerator: 'CmdOrCtrl+W',
          enabled: false, // Disabled when no file is open; enabled by the renderer's synced state
          click: () => getMainWindow()?.webContents.send('menu:close-file'),
        },
        {
          id: 'close-workspace',
          label: menuT('menu.closeWorkspace'),
          accelerator: 'CmdOrCtrl+Shift+W',
          click: () => getMainWindow()?.webContents.send('menu:close-workspace'),
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
          click: () => getMainWindow()?.webContents.send('menu:toggle-sidebar'),
        },
        {
          label: menuT('menu.togglePreview'),
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => getMainWindow()?.webContents.send('menu:toggle-preview'),
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
            const wc = getMainWindow()?.webContents
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
          click: () => getMainWindow()?.webContents.send('menu:about'),
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

// Register the menu IPC handlers. These were top-level registrations in index.ts:
//   - menu:set-editable / set-has-document / set-printing (module top level)
//   - app:set-language (inside whenReady, but semantically menu language sync)
// We group them here. Called from the entry BEFORE whenReady so the top-level
// registrations keep their original timing; app:set-language is harmlessly
// registered a little earlier (it is a passive listener, fired only when the
// renderer changes language).
export function registerMenuHandlers(): void {
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

  // Renderer sends its (persisted or system) UI language so the native menu matches.
  // notify=false: we must not echo back to the renderer here, or we'd create a sync loop
  // (renderer → main → menu:language → renderer → main → ...).
  ipcMain.on('app:set-language', (_event, locale: 'en' | 'zh-CN') => {
    if (locale === 'en' || locale === 'zh-CN') setMenuLocale(locale, false)
  })
}

// Register the menu IPC handlers from the entry (electron/main/index.ts) via an
// explicit registerMenuHandlers() call, NOT by self-invoking on import. A self-executing
// module with no *used* export gets tree-shaken by Rollup (see lifecycle.ts for the same
// class of regression): the menu:set-* / app:set-language listeners would silently
// disappear, so the native menu would never re-enable Save / Reload / Export as the
// renderer syncs state. The entry calls registerMenuHandlers() right before setupMenu().
