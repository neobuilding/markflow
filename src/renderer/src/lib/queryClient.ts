import { QueryClient } from '@tanstack/react-query'

// Shared TanStack Query client singleton. Exported from its own module (not main.tsx)
// so non-component code (e.g. the UI store) can invalidate queries without pulling in
// main.tsx's top-level ReactDOM.createRoot side effect.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 10, // 10s
      gcTime: 1000 * 60 * 5, // 5m
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

// Centralised query keys. Kept here (import-cycle-free) so both the UI store and the
// document hooks can reference them without creating a ui.ts <-> useDocuments.ts cycle.
export const DOCS_KEY = ['documents'] as const

// e2e test hook: expose the real query client (dev only, tree-shaken from prod builds)
// so end-to-end tests can invalidate caches the same way the app does.
if (import.meta.env.DEV) {
  ;(window as unknown as { __queryClient?: QueryClient }).__queryClient = queryClient
}
