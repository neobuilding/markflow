import { onIpc } from './_shared'

// Menu event listeners
export const onMenuEvent = (
  event:
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
    | 'language',
  callback: (data?: string | string[]) => void,
) => onIpc(`menu:${event}`, callback)

// A file open in the editor was modified on disk by another program
export const onFileChanged = (callback: (data: { id: string; filePath: string }) => void) =>
  onIpc('app:file-changed', callback)

// A file was added or removed in the directory of an open document; the renderer
// should refresh the sidebar list (does NOT prompt to reload, unlike onFileChanged).
export const onFolderChanged = (callback: (data: { dirPath: string }) => void) =>
  onIpc('app:folder-changed', callback)

// ONE document's identity changed outside the app — its file was deleted (marked
// missing) or renamed. The renderer should re-read just that document's record so the
// title bar follows. Narrower than onFolderChanged, which refreshes the whole list.
export const onDocumentRefresh = (callback: (data: { id: string }) => void) =>
  onIpc('app:document-refresh', callback)

// Paths opened via CLI args / file association / drag-onto-dock
export const onOpenPaths = (callback: (paths: string[]) => void) =>
  onIpc('app:open-paths', callback)

// Main requests the renderer to close the workspace (running the unified unsaved
// prompt) before quitting the app.
export const onAppRequestQuit = (callback: () => void) => onIpc('app:request-quit', callback)
