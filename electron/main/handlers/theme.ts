// Theme IPC handlers (app:get-theme / app:set-theme).
import { ipcMain, nativeTheme } from 'electron'

export function registerThemeHandlers(): void {
  ipcMain.handle('app:get-theme', () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'))
  ipcMain.handle('app:set-theme', (_event, theme: 'light' | 'dark' | 'system') => {
    nativeTheme.themeSource = theme
  })
}
