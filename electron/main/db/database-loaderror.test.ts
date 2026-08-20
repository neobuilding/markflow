import { describe, it, expect, vi } from 'vitest'

// Force the better-sqlite3 dynamic import to fail so the graceful-failure path in
// initDatabase() (the try/catch around `await import('better-sqlite3')`) is exercised.
// A throwing mock factory makes the dynamic import reject, which the app's try/catch
// catches and re-throws as a friendly "Failed to load better-sqlite3" error.
//
// NOTE: vitest wraps a thrown mock-factory value into its own Error, so the assertion
// below only checks the app-level message it produces — not the original cause's shape.
vi.mock('better-sqlite3', () => {
  throw new Error('Cannot find native binding for better-sqlite3')
})

describe('database — native module load failure', () => {
  it('surfaces a friendly error when better-sqlite3 cannot load', async () => {
    vi.resetModules()
    const mod = await import('./database')
    let thrown: unknown
    try {
      await mod.initDatabase()
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toMatch(/Failed to load better-sqlite3/)
    expect(mod.getDb).toThrow(/not initialized/i)
  })
})
