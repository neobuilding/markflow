import { describe, it, expect, beforeEach, vi } from 'vitest'

// electron is not exercised by state.ts, but the module imports the type only,
// so no runtime electron is needed. Stub it to be safe.
vi.mock('electron', () => ({}))

const state = await import('./state')

beforeEach(() => {
  // reset module-level mutable state between tests
  state.setMainWindow(null)
  state.setIsQuiting(false)
  state.setReadyToQuit(false)
  state.pendingInitialPaths.length = 0
})

describe('main-process state', () => {
  it('tracks the main window reference', () => {
    expect(state.getMainWindow()).toBeNull()
    const fake = { id: 1 } as unknown as import('electron').BrowserWindow
    state.setMainWindow(fake)
    expect(state.getMainWindow()).toBe(fake)
    state.setMainWindow(null)
    expect(state.getMainWindow()).toBeNull()
  })

  it('tracks the quitting flag', () => {
    expect(state.getIsQuiting()).toBe(false)
    state.setIsQuiting(true)
    expect(state.getIsQuiting()).toBe(true)
  })

  it('tracks the ready-to-quit flag', () => {
    expect(state.getReadyToQuit()).toBe(false)
    state.setReadyToQuit(true)
    expect(state.getReadyToQuit()).toBe(true)
  })

  it('accumulates pending initial paths and allows draining', () => {
    state.pendingInitialPaths.push('/a.md', '/b.md')
    expect(state.pendingInitialPaths).toHaveLength(2)
    const drained = state.pendingInitialPaths.splice(0, state.pendingInitialPaths.length)
    expect(drained).toEqual(['/a.md', '/b.md'])
    expect(state.pendingInitialPaths).toHaveLength(0)
  })
})
