// Zero-dependency state base for the main process.
//
// Splitting index.ts into focused modules created a potential cycle:
//   window.ts   ── needs readyToQuit ──► lifecycle.ts
//   lifecycle.ts ── needs mainWindow ─► window.ts
//   menu.ts / handlers/* ── need mainWindow ─► window.ts
//   handlers/app.ts ── needs pendingInitialPaths ─► ?
//
// This module holds the shared mutable state and imports NOTHING from the rest
// of the main process, so every other module can depend on it in a single
// direction (state.ts ← {window, menu, lifecycle, handlers/*}), breaking the
// cycle.
import type { BrowserWindow } from 'electron'

let mainWindow: BrowserWindow | null = null
export const getMainWindow = (): BrowserWindow | null => mainWindow
export const setMainWindow = (w: BrowserWindow | null): void => {
  mainWindow = w
}

// Exit flag for the best-effort draft purge in lifecycle's before-quit handler.
// The per-window unsaved guard lives in WindowContext; there is deliberately no
// process-global "is quitting" flag that could skip another window's guard.
let readyToQuit = false
export const getReadyToQuit = () => readyToQuit
export const setReadyToQuit = (v: boolean) => {
  readyToQuit = v
}

// Paths accumulated before the app is ready: fed from open-file / second-instance
// / app:get-initial-paths. Filled by the entry (index.ts) from extractArgvPaths
// because state.ts deliberately does not depend on `app`.
export const pendingInitialPaths: string[] = []
