import { useQuery } from '@tanstack/react-query'
import { useUIStore } from '../store/ui'

export function useSearch() {
  const { searchQuery } = useUIStore()

  const result = useQuery({
    queryKey: ['search', searchQuery],
    queryFn: () => window.api.search.query(searchQuery),
    enabled: searchQuery.trim().length > 0,
    staleTime: 1000 * 5
  })

  return result
}
