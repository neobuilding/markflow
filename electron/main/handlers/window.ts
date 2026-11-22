// Window control IPC handlers: maximize / unmaximize / is-maximized.
// Extracted from index.ts.
//
// NOTE: do not add window:focus / webContents.focus() IPC handlers.
// That approach was disproven (no-op when the window is already foreground);
// the editor-focus root cause was fixed by dialog:confirm (app-modal).
//
// In a multi-window app the window-control buttons must act on the window that SENT the request,
// not the globally tracked "main" window (which is simply the last one created).
import { ipcMain } from 'electron'
import { scopedHandleFor } from '../model/ipcScope'
import { getMainWindow } from '../state'
import { contextFor } from '../model/windowContext'

function senderWindow(event?: { sender?: { id: number } } | null) {
  return contextFor(event?.sender)?.win ?? getMainWindow()
}

export function registerWindowHandlers(): void {
  scopedHandleFor(ipcMain, 'window:maximize', (event) => senderWindow(event)?.maximize())
  scopedHandleFor(ipcMain, 'window:unmaximize', (event) => senderWindow(event)?.unmaximize())
  scopedHandleFor(ipcMain, 'window:is-maximized', (event) => !!senderWindow(event)?.isMaximized())
}
