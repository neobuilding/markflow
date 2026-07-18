/// <reference types="vite/client" />

import type { Document, SearchResult, ThemeMode } from './types'

// 文件在磁盘上的状态信息（大小 / 创建时间 / 修改时间）
export interface FileStat {
  exists: boolean
  size: number
  createdAt: number
  updatedAt: number
}

// 主进程通过原生菜单 / 文件关联触发的事件名
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
  | 'file-details'
  | 'about'

// Electron preload bridge exposed on window.api
export interface Api {
  documents: {
    list: (folderPath?: string) => Promise<Document[]>
    get: (id: string) => Promise<Document | null>
    create: (params: { title?: string; folderPath?: string; content?: string }) => Promise<Document>
    update: (id: string, updates: { title?: string; content?: string }) => Promise<Document | null>
    delete: (id: string) => Promise<void>
    import: (filePath: string) => Promise<Document | null>
    importMany: (filePaths: string[]) => Promise<Document[]>
    saveAs: (id: string, filePath: string, params: { title?: string; content?: string }) => Promise<Document | null>
    reload: (id: string) => Promise<Document | null>
    stat: (filePath: string) => Promise<FileStat | null>
    eol: (filePath: string) => Promise<'\r\n' | '\n'>
    watch: (id: string) => Promise<void>
    unwatch: (id: string) => Promise<void>
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
  }
  window: {
    maximize: () => Promise<void>
    unmaximize: () => Promise<void>
    isMaximized: () => Promise<boolean>
  }
  menu: {
    setEditable: (editable: boolean) => void
    setHasDocument: (has: boolean) => void
  }
  onMenuEvent: (event: MenuEvent, callback: (data?: string | string[]) => void) => () => void
  onFileChanged: (callback: (data: { id: string; filePath: string }) => void) => () => void
  onOpenPaths: (callback: (paths: string[]) => void) => () => void
}

declare global {
  interface Window {
    api: Api
  }
}
