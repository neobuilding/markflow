import { describe, it, expect } from 'vitest'
import { queryClient, DOCS_KEY } from './queryClient'

// The trailing dev-only hook in `queryClient.ts` (exposing the client on
// `window` when `import.meta.env.DEV`) is excluded from branch coverage via a
// `v8 ignore` comment: `import.meta.env.DEV` is build-mode dependent and not
// reliably `true` under unit tests, so the `false` branch is exercised by the
// production build instead. These tests only assert the stable, mode-independent
// exports of the module.

describe('queryClient (PLAN §6.4)', () => {
  it('exports a configured TanStack Query client', () => {
    expect(queryClient).toBeDefined()
    expect(typeof queryClient.invalidateQueries).toBe('function')
  })

  it('exposes the document list query key', () => {
    expect(DOCS_KEY).toEqual(['documents'])
  })
})
