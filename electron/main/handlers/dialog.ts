// Dialog IPC handlers: open-files / open-folder / select-folder / save-file /
// save-html / confirm. Extracted from index.ts.
import { ipcMain, dialog } from 'electron'
import { menuT } from '../i18n'
import { collectMarkdownFiles } from '../lib/md-files'

export function registerDialogHandlers(): void {
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

  // App-modal confirm box used by the renderer to replace window.confirm. Being app-modal (not
  // OS-modal like window.confirm), Electron returns focus to the renderer after it closes, so it
  // does not trigger the OS window-blur that window.confirm does — which is what previously left
  // document.hasFocus() stuck false and broke typing after switching dirty files.
  ipcMain.handle(
    'dialog:confirm',
    async (
      _event,
      opts: { message: string; detail?: string; okText?: string; cancelText?: string },
    ): Promise<boolean> => {
      const result = await dialog.showMessageBox({
        type: 'question',
        buttons: [opts.cancelText ?? 'Cancel', opts.okText ?? 'OK'],
        defaultId: 1,
        cancelId: 0,
        message: opts.message,
        detail: opts.detail,
      })
      return result.response === 1
    },
  )

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
}
