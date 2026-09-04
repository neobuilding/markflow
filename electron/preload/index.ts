// electron/preload/index.ts - Preload script (ESM)
import { contextBridge } from 'electron'
import { documentsApi } from './api/documents'
import { exportApi } from './api/export'
import { searchApi } from './api/search'
import { appApi } from './api/app'
import { clipboardApi } from './api/clipboard'
import { filesApi } from './api/files'
import { dialogApi } from './api/dialog'
import { windowApi } from './api/window'
import { menuApi } from './api/menu'
import {
  onMenuEvent,
  onFileChanged,
  onFolderChanged,
  onDocumentRefresh,
  onOpenPaths,
  onAppRequestQuit,
} from './api/events'

// Custom APIs exposed to renderer. Each group is assembled from the per-domain
// modules under ./api so this file only does composition, not implementation.
const api = {
  documents: documentsApi,
  export: exportApi,
  search: searchApi,
  app: appApi,
  clipboard: clipboardApi,
  files: filesApi,
  dialog: dialogApi,
  window: windowApi,
  menu: menuApi,
  // Event subscriptions are spread to the top level (window.api.onMenuEvent, ...)
  onMenuEvent,
  onFileChanged,
  onFolderChanged,
  onDocumentRefresh,
  onOpenPaths,
  onAppRequestQuit,
}

contextBridge.exposeInMainWorld('api', api)
