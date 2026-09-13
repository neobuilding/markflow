import { ipcRenderer } from 'electron'

// Search bridge wraps the main-process `search:query` IPC handler.
// `scopeFolder` limits results to a folder and its sub-folders (sidebar search);
// `mode` switches between file-name-only and full-text (content) search.
export interface SearchOptions {
  scopeFolder?: string | null
  mode?: 'filename' | 'content'
}

export const searchApi = {
  query: (q: string, opts?: SearchOptions) =>
    ipcRenderer.invoke('search:query', {
      query: q,
      scopeFolder: opts?.scopeFolder ?? null,
      mode: opts?.mode ?? 'content',
    }),
}
