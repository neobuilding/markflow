// Search wire types shared by BOTH processes. The main process builds these in
// `electron/main/ipc/search.ts`, they travel over IPC, and the renderer consumes them. They used
// to be declared twice — once in the IPC module and once in the renderer's `types/index.ts` — with
// a "mirrors the renderer's ..." comment keeping them in sync by hand. Defined once here so the
// two sides cannot drift, the same rationale as `shared/fileUtils.ts`.

// Search mode: 'filename' indexes only the document title (file name); 'content' indexes
// title + body + folder path (the original full-text behaviour).
export type SearchMode = 'filename' | 'content'

// One in-document occurrence of the query, surfaced by the resident sidebar search panel.
// `start`/`end` are character offsets into the *saved* document content (CodeMirror doc
// positions), so the renderer can jump the editor cursor straight to the hit. `excerpt` is the
// matched line, truncated; `excerptStart`/`excerptEnd` are the matched substring's range *within*
// that (already-truncated) excerpt, ready to wrap in `<mark>` after HTML-escaping the three
// segments (see SearchPanel). Carrying the highlight range explicitly avoids any fragile
// "re-find the term inside the excerpt" logic in the renderer.
export interface SearchMatch {
  line: number
  start: number
  end: number
  excerpt: string
  excerptStart: number
  excerptEnd: number
}

// One search hit returned to the renderer. A body snippet is deliberately NOT returned
// (data-minimization: the UI only ever shows the title + on-disk path), so there is no `snippet`
// field. `matches` carries the bounded per-document hit context for content-mode results instead
// (empty for file-name mode and for docs with no literal occurrence). `truncated` is set when the
// candidate doc set was capped (see MAX_RESULT_DOCS in search.ts).
export interface SearchResult {
  id: string
  title: string
  folderPath: string
  // Absolute on-disk path of the matching document. Empty for memory-only drafts that have no
  // file yet.
  filePath: string
  score: number
  updatedAt: number
  matches: SearchMatch[]
  truncated?: boolean
}
