import { describe, it, expect } from 'vitest'
import { useUIStore } from './ui'

// The trailing dev-only hook in `ui.ts` (exposing the store on `window` when
// `import.meta.env.DEV`) is excluded from branch coverage via a `v8 ignore`
// comment: `import.meta.env.DEV` is build-mode dependent and not reliably `true`
// under unit tests, so the `false` branch is exercised by the production build
// instead. These tests only assert the stable, mode-independent exports.

describe('useUIStore (PLAN §6.4)', () => {
  it('exports a zustand store factory', () => {
    expect(typeof useUIStore).toBe('function')
    expect(typeof useUIStore.getState).toBe('function')
  })
})
