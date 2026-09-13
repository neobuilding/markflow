import { useQuery } from '@tanstack/react-query'
import { useUIStore } from '../store/ui'

export function useSearch() {
  const { searchQuery, searchMode, activeFolder } = useUIStore()

  const result = useQuery({
    // Re-run whenever the query text, the search mode, or the active folder (which
    // scopes the sidebar search to "this folder and its sub-folders") changes.
    queryKey: ['search', searchQuery, searchMode, activeFolder],
    queryFn: () =>
      window.api.search.query(searchQuery, { scopeFolder: activeFolder, mode: searchMode }),
    enabled: searchQuery.trim().length > 0,
    staleTime: 1000 * 5,
  })

  return result
}
