// Dialog IPC handlers: open-files / open-folder / select-folder / save-file /
// save-html / confirm. Extracted from index.ts.
import { ipcMain, dialog } from 'electron'
import { scopedHandleFor } from '../model/ipcScope'
import { menuT } from '../i18n'
import { collectMarkdownFiles } from '../lib/md-files'
import type { ExternalOpenChoice, WorkspaceExternalChoice } from '../../../shared/linkTypes'

export function registerDialogHandlers(): void {
  // Let the renderer proactively open a file-picker dialog
  scopedHandleFor(ipcMain, 'dialog:open-files', async () => {
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
  scopedHandleFor(ipcMain, 'dialog:open-folder', async () => {
    const result = await dialog.showOpenDialog({
      title: menuT('menu.dlgOpenFolder'),
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return []
    return collectMarkdownFiles(result.filePaths[0])
  })

  // Let the renderer proactively open a folder-picker dialog, returning only the chosen folder path
  scopedHandleFor(ipcMain, 'dialog:select-folder', async () => {
    const result = await dialog.showOpenDialog({
      title: menuT('menu.openFolder'),
      properties: ['openDirectory'],
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // Let the renderer proactively open a "Save As" dialog, returning the chosen path (null if canceled)
  scopedHandleFor(ipcMain, 'dialog:save-file', async (_event, defaultPath?: string) => {
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
  // does not trigger the OS window-blur that window.confirm does which is what previously left
  // document.hasFocus() stuck false and broke typing after switching dirty files.
  scopedHandleFor(
    ipcMain,
    'dialog:confirm',
    async (
      _event,
      opts: { message: string; detail?: string; okText?: string; cancelText?: string },
    ): Promise<boolean> => {
      const result = await dialog.showMessageBox({
        type: 'question',
        // Localized fallbacks: a caller that omits okText/cancelText must not leak raw
        // English 'OK'/'Cancel' into a Chinese UI.
        buttons: [opts.cancelText ?? menuT('app.cancel'), opts.okText ?? menuT('app.ok')],
        defaultId: 1,
        cancelId: 0,
        message: opts.message,
        detail: opts.detail,
      })
      return result.response === 1
    },
  )

  // ADR-0038 §3.1.3: opening a web link or a local non-Markdown file with the OS default handler is
  // an explicit choice. Three buttons (Open / Copy / Cancel) mirror VS Code; `cancelId` maps the
  // window close / Esc path to 'cancel' so no handler is called by accident.
  scopedHandleFor(
    ipcMain,
    'dialog:confirm-open-external',
    async (_event, target: string): Promise<ExternalOpenChoice> => {
      const result = await dialog.showMessageBox({
        type: 'question',
        buttons: [
          menuT('app.openExternalOpen'),
          menuT('app.openExternalCopy'),
          menuT('app.cancel'),
        ],
        defaultId: 0,
        cancelId: 2,
        message: menuT('app.openExternalTitle'),
        detail: target,
      })
      return result.response === 0 ? 'open' : result.response === 1 ? 'copy' : 'cancel'
    },
  )

  // A file (preview link / dropped / file-association) resolved outside the workspace root.
  // Four explicit exits: separate window, here keeping the workspace, here switching the
  // workspace, or cancel. Default is the new window (least destructive to the current session).
  scopedHandleFor(
    ipcMain,
    'dialog:confirm-workspace-external',
    async (_event, target: string): Promise<WorkspaceExternalChoice> => {
      const result = await dialog.showMessageBox({
        type: 'question',
        buttons: [
          menuT('app.workspaceExternalNewWindow'),
          menuT('app.workspaceExternalKeep'),
          menuT('app.workspaceExternalSwitch'),
          menuT('app.cancel'),
        ],
        defaultId: 0,
        cancelId: 3,
        message: menuT('app.workspaceExternalTitle'),
        detail: target,
      })
      switch (result.response) {
        case 0:
          return 'new-window'
        case 1:
          return 'keep-workspace'
        case 2:
          return 'switch-workspace'
        default:
          return 'cancel'
      }
    },
  )

  // Let the renderer proactively open an "Export as HTML" dialog (R7) with .html filter by default.
  scopedHandleFor(ipcMain, 'dialog:save-html', async (_event, defaultPath?: string) => {
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
