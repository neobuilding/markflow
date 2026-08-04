/// <reference types="vite/client" />

import type { Document, SearchResult, ThemeMode } from './types'

// Status information of a file on disk (size / creation time / modification time)
export interface FileStat {
  exists: boolean
  size: number
  createdAt: number
  updatedAt: number
}

// Event names triggered by the main process via native menus / file associations
export type MenuEvent =
  | 'new-document'
  | 'save'
  | 'save-as'
  | 'reload'
  | 'toggle-sidebar'
  | 'toggle-preview'
  | 'open-folder'
  | 'open-files'
  | 'close-workspace'
  | 'close-file'
  | 'file-details'
  | 'about'
  | 'export-html'
  | 'print'
  | 'language'

// Electron preload bridge exposed on window.api
export interface Api {
  documents: {
    list: (folderPath?: string) => Promise<Document[]>
    get: (id: string) => Promise<Document | null>
    create: (
      params: {
        title?: string
        folderPath?: string
        content?: string
        ext?: string
        memoryOnly?: boolean
      },
    ) => Promise<Document>
    update: (id: string, updates: { title?: string; content?: string }) => Promise<Document | null>
    delete: (id: string) => Promise<void>
    import: (filePath: string) => Promise<Document | null>
    importMany: (filePaths: string[]) => Promise<Document[]>
    saveAs: (id: string, filePath: string, params: { title?: string; content?: string }) => Promise<Document | null>
    reload: (id: string) => Promise<Document | null>
    setEncoding: (id: string, encoding: string) => Promise<Document | null>
    stat: (filePath: string) => Promise<FileStat | null>
    eol: (filePath: string) => Promise<'\r\n' | '\n'>
    watch: (id: string) => Promise<void>
    unwatch: (id: string) => Promise<void>
  }
  export: {
    embedImages: (html: string) => Promise<string>
    write: (path: string, html: string, overwrite?: boolean) => Promise<void>
    print: (html: string) => Promise<void>
  }
  search: {
    query: (q: string) => Promise<SearchResult[]>
  }
  app: {
    getTheme: () => Promise<ThemeMode>
    setTheme: (theme: ThemeMode) => Promise<void>
    getVersion: () => Promise<string>
    getInitialPaths: () => Promise<string[]>
    showInFolder: (filePath: string) => Promise<void>
    setLanguage: (locale: 'en' | 'zh-CN') => void
    allowQuit: () => void
  }
  files: {
    resolvePaths: (paths: string[]) => Promise<{ directories: string[]; markdownFiles: string[] }>
    getPathForFile: (file: File) => string
  }
  dialog: {
    openFiles: () => Promise<string[]>
    openFolder: () => Promise<string | null>
    openFolderPath: () => Promise<string | null>
    saveFile: (defaultPath?: string) => Promise<string | null>
    saveHtmlFile: (defaultPath?: string) => Promise<string | null>
  }
  window: {
    maximize: () => Promise<void>
    unmaximize: () => Promise<void>
    isMaximized: () => Promise<boolean>
  }
  menu: {
    setEditable: (editable: boolean) => void
    setHasDocument: (has: boolean) => void
    setPrinting: (printing: boolean) => void
  }
  onMenuEvent: (event: MenuEvent, callback: (data?: string | string[]) => void) => () => void
  onFileChanged: (callback: (data: { id: string; filePath: string }) => void) => () => void
  onOpenPaths: (callback: (paths: string[]) => void) => () => void
  onAppRequestQuit: (callback: () => void) => () => void
}

declare global {
  interface Window {
    api: Api
  }
}
