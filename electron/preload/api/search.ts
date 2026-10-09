import { ipcRenderer } from 'electron'
import type { SearchMode } from '../../../shared/searchTypes'

// Search bridge wraps the main-process `search:query` IPC handler.
// `scopeFolder` limits results to a folder and its sub-folders (sidebar search);
// `mode` switches between file-name-only and full-text (content) search. The mode union is
// imported from the shared wire types rather than re-declared, so the two sides cannot drift.
export interface SearchOptions {
  scopeFolder?: string | null
  mode?: SearchMode
}

export const searchApi = {
  query: (q: string, opts?: SearchOptions) =>
    ipcRenderer.invoke('search:query', {
      query: q,
      scopeFolder: opts?.scopeFolder ?? null,
      mode: opts?.mode ?? 'content',
    }),
}
