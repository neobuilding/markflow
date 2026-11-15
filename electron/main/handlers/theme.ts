// Theme IPC handlers (app:get-theme / app:set-theme).
import { ipcMain, nativeTheme } from 'electron'
import { applyThemeToMenu, type ThemeMode } from '../menu'

export function registerThemeHandlers(): void {
  ipcMain.handle('app:get-theme', () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'))
  ipcMain.handle('app:set-theme', (_event, theme: ThemeMode) => {
    nativeTheme.themeSource = theme
    // Keep the native theme menu's radio group in sync (the renderer is the source of truth for the
    // value; main only mirrors it here so the checkmark reflects the current choice).
    applyThemeToMenu(theme)
  })
}
