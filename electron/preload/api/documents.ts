import { ipcRenderer } from 'electron'

// Document operations bridge wraps the main-process `documents:*` IPC handlers
export const documentsApi = {
  list: (folderPath?: string) => ipcRenderer.invoke('documents:list', folderPath),
  get: (id: string) => ipcRenderer.invoke('documents:get', id),
  create: (params: {
    title?: string
    folderPath?: string
    content?: string
    ext?: string
    memoryOnly?: boolean
  }) => ipcRenderer.invoke('documents:create', params),
  update: (id: string, updates: { title?: string; content?: string }) =>
    ipcRenderer.invoke('documents:update', id, updates),
  delete: (id: string) => ipcRenderer.invoke('documents:delete', id),
  import: (filePath: string) => ipcRenderer.invoke('documents:import', filePath),
  importMany: (filePaths: string[]) => ipcRenderer.invoke('documents:import-many', filePaths),
  saveAs: (id: string, filePath: string, params: { title?: string; content?: string }) =>
    ipcRenderer.invoke('documents:save-as', id, filePath, params),
  reload: (id: string) => ipcRenderer.invoke('documents:reload', id),
  setEncoding: (id: string, encoding: string) =>
    ipcRenderer.invoke('documents:set-encoding', id, encoding),
  stat: (filePath: string) => ipcRenderer.invoke('documents:stat', filePath),
  eol: (filePath: string) => ipcRenderer.invoke('documents:eol', filePath),
  resolveAppdoc: (src: string) => ipcRenderer.invoke('documents:resolve-appdoc', src),
  // Set the line endings of a file on disk (destructive write)
  setEol: (filePath: string, eol: '\r\n' | '\n') =>
    ipcRenderer.invoke('documents:set-eol', filePath, eol),
  // Re-detect a file's encoding without changing its bytes
  detectEncoding: (filePath: string) => ipcRenderer.invoke('documents:detect-encoding', filePath),
  // Folder operations
  createFolder: (folderPath: string) => ipcRenderer.invoke('documents:create-folder', folderPath),
  renameFolder: (oldPath: string, newPath: string) =>
    ipcRenderer.invoke('documents:rename-folder', oldPath, newPath),
  renameFile: (oldPath: string, newPath: string) =>
    ipcRenderer.invoke('documents:rename-file', oldPath, newPath),
  // Undo the most recent file/folder rename. Single slot; the main process owns the history.
  undoRename: () => ipcRenderer.invoke('documents:undo-rename'),
  deleteFolder: (folderPath: string) => ipcRenderer.invoke('documents:delete-folder', folderPath),
  // Directory listing : every folder below the given path, empty ones
  // included, so the sidebar tree is not limited to folders that hold a Markdown file.
  listFolders: (folderPath: string) => ipcRenderer.invoke('documents:list-folders', folderPath),
  // Folder watching is owned entirely by the main process (chokidar): the renderer
  // only tells it which folder was opened, and when the workspace is closed.
  setOpenFolder: (folderPath: string) =>
    ipcRenderer.invoke('documents:set-open-folder', folderPath),
  clearOpenFolders: () => ipcRenderer.invoke('documents:clear-open-folders'),
}
