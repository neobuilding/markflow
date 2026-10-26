import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useUIStore } from '../store/ui'
import type { SearchQueryResponse } from '../types'

const EMPTY: SearchQueryResponse = {
  results: [],
  diagnostics: [],
  appliedScope: { root: null, include: [], exclude: [] },
  truncated: false,
}

/**
 * Quick Open (Ctrl/Cmd+K) query. File names and paths only — the surface has no scope concept and
 * no body search (ADR-0023), so it sends neither.
 */
export function useQuickOpen() {
  const searchQuery = useUIStore((s) => s.searchQuery)

  return useQuery({
    queryKey: ['quick-open', searchQuery],
    queryFn: () => window.api.search.query({ query: searchQuery, mode: 'filename' }),
    // A query containing CR/LF is meaningless for a filename/title lookup; never issue the call
    // (ADR-0023 ruling 13 — multiline is intercepted on the renderer, not in the IPC envelope).
    enabled: searchQuery.trim().length > 0 && !/[\r\n]/.test(searchQuery),
    staleTime: 1000 * 5,
  })
}

// Debounced copy of the document-state revision: the revision changes on every keystroke in the
// editor, and re-querying the whole workspace per keystroke would be wasteful.
function useDebouncedDocumentStateRevision(): number {
  const revision = useUIStore((s) => s.documentStateRevision)
  const [debounced, setDebounced] = useState(revision)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(revision), 300)
    return () => clearTimeout(id)
  }, [revision])
  return debounced
}

/** The Search view response, always a full envelope (never `undefined`). */
export function useSearchView(): { data: SearchQueryResponse; isFetching: boolean } {
  const searchQuery = useUIStore((s) => s.searchQuery)
  const searchInclude = useUIStore((s) => s.searchInclude)
  const searchExclude = useUIStore((s) => s.searchExclude)
  const searchMatchCase = useUIStore((s) => s.searchMatchCase)
  const searchWholeWord = useUIStore((s) => s.searchWholeWord)
  const searchRegexp = useUIStore((s) => s.searchRegexp)
  const dirtyRevision = useDebouncedDocumentStateRevision()

  const result = useQuery({
    queryKey: [
      'search-view',
      searchQuery,
      searchInclude,
      searchExclude,
      searchMatchCase,
      searchWholeWord,
      searchRegexp,
      dirtyRevision,
    ],
    queryFn: () => {
      // Read the registry at CALL time so the snapshot always carries the current buffer content
      // and the revision is never the throttled one the main process validates against (D28).
      const { unsavedBuffers, documentStateRevision } = useUIStore.getState()
      return window.api.search.query({
        query: searchQuery,
        mode: 'content',
        include: searchInclude,
        exclude: searchExclude,
        matchCase: searchMatchCase,
        wholeWord: searchWholeWord,
        regexp: searchRegexp,
        dirtyDocumentSnapshots: Object.entries(unsavedBuffers).map(([documentId, b]) => ({
          documentId,
          content: b.content,
          revision: b.revision,
        })),
        documentStateRevision,
      })
    },
    // A query containing CR/LF never reaches the IPC handler — it is intercepted on the renderer
    // and shown inline as a hint (ADR-0023 ruling 13). The empty fallback remains until the user
    // removes the newline, so the main process never has to reject `search.multilineUnsupported`.
    enabled: searchQuery.trim().length > 0 && !/[\r\n]/.test(searchQuery),
    staleTime: 1000 * 5,
  })

  return { data: result.data ?? EMPTY, isFetching: result.isFetching }
}
