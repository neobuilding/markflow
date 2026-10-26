import { ipcRenderer } from 'electron'
import type { SearchQueryOptions, SearchQueryResponse } from '../../../shared/searchTypes'

// Search bridge wraps the main-process `search:query` IPC handler.
//
// The query shape is the frozen contract in `shared/searchTypes.ts` (ADR-0023): a discriminated
// union, so the Quick Open surface cannot accidentally send scope fields and the Search view
// cannot forget the dirty-buffer snapshot the content mode requires.
export const searchApi = {
  query: (options: SearchQueryOptions): Promise<SearchQueryResponse> =>
    ipcRenderer.invoke('search:query', options),
}
