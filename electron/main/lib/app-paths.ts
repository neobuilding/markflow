// Build-time / runtime paths used across the main process.
// Extracted from index.ts so window.ts (and any other module) can read these
// without forcing index.ts to keep them as module-level constants.
import { join } from 'node:path'
import { app } from 'electron'

// In production, app.getAppPath() returns the path to the extracted asar
// (e.g. "D:\...\app.asar"), so joining dist-electron/dist/renderer works.
// In dev, we rely on Vite's VITE_DEV_SERVER_URL.
export const MAIN_DIST = join(app.getAppPath(), 'dist-electron')
export const RENDERER_DIST = join(app.getAppPath(), 'dist', 'renderer')
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'] ?? ''
