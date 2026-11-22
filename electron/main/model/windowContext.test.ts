// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import type { BrowserWindow } from 'electron'
import {
  type WindowContext,
  registerWindow,
  unregisterWindow,
  contextFor,
  allContexts,
  activeContext,
  withContext,
  currentContext,
  currentStore,
  __resetWindowContextsForTests,
} from './windowContext'

function fakeWin(id: number): BrowserWindow {
  return { webContents: { id } } as unknown as BrowserWindow
}

beforeEach(() => {
  __resetWindowContextsForTests()
})

describe('registerWindow', () => {
  it('creates a fully initialised context keyed by webContents.id and makes it active', () => {
    const win = fakeWin(42)
    const ctx = registerWindow(win)

    expect(ctx.id).toBe(42)
    expect(ctx.win).toBe(win)
    expect(ctx.docs).toBeInstanceOf(Map)
    expect(ctx.workspaceRoot).toBeNull()
    expect(ctx.workspaceSession).toBe(0)
    expect(ctx.closeForceTimer).toBeNull()
    expect(ctx.quitPending).toBe(false)
    expect(ctx.closeAllowed).toBe(false)
    expect(ctx.pendingPaths).toEqual([])
    expect(activeContext()).toBe(ctx)
  })
})

describe('unregisterWindow', () => {
  it('removes a context and switches active to the last remaining one', () => {
    const a = registerWindow(fakeWin(1))
    const b = registerWindow(fakeWin(2))
    expect(activeContext()).toBe(b)

    unregisterWindow(2)

    expect(activeContext()).toBe(a)
    expect(allContexts()).toEqual([a])
  })

  it('clears active when the removed context was the only one', () => {
    registerWindow(fakeWin(1))
    unregisterWindow(1)
    expect(activeContext()).toBeUndefined()
    expect(allContexts()).toEqual([])
  })

  it('leaves active unchanged when a non-active context is removed', () => {
    registerWindow(fakeWin(1))
    const b = registerWindow(fakeWin(2))
    unregisterWindow(1)
    expect(activeContext()).toBe(b)
    expect(allContexts()).toEqual([b])
  })
})

describe('contextFor', () => {
  it('returns the context matching the sender id', () => {
    const a = registerWindow(fakeWin(1))
    registerWindow(fakeWin(2))
    expect(contextFor({ id: 1 })).toBe(a)
  })

  it('falls back to the active context for an unknown sender or a null event sender', () => {
    registerWindow(fakeWin(1))
    const b = registerWindow(fakeWin(2))
    expect(contextFor({ id: 999 })).toBe(b)
    expect(contextFor(null)).toBe(b)
    expect(contextFor()).toBe(b)
  })

  it('returns undefined when there is no active context and the sender is unknown', () => {
    expect(contextFor(null)).toBeUndefined()
  })
})

describe('allContexts / activeContext', () => {
  it('lists every registered context in registration order', () => {
    const a = registerWindow(fakeWin(1))
    const b = registerWindow(fakeWin(2))
    expect(allContexts()).toEqual([a, b])
  })

  it('returns an empty list and undefined active with no windows', () => {
    expect(allContexts()).toEqual([])
    expect(activeContext()).toBeUndefined()
  })
})

describe('withContext / currentContext / currentStore', () => {
  it('runs a callback with the given context as the implicit scope', () => {
    const ctx = registerWindow(fakeWin(1))
    withContext(ctx, () => {
      expect(currentContext()).toBe(ctx)
      expect(currentStore()).toBe(ctx.docs)
    })
  })

  it('uses the headless fallback when no context is supplied and none is active', () => {
    withContext(undefined, () => {
      const c = currentContext()
      expect(c.id).toBe(-1)
      expect(currentStore()).toBe(c.docs)
    })
  })

  it('currentContext resolves to the active window outside any scope', () => {
    const ctx = registerWindow(fakeWin(1))
    expect(currentContext()).toBe(ctx)
  })

  it('currentContext resolves to the fallback with no window and no scope', () => {
    expect(currentContext().id).toBe(-1)
  })

  it('nested scopes restore the outer context on exit', () => {
    const a = registerWindow(fakeWin(1))
    const b = registerWindow(fakeWin(2))
    withContext(a, () => {
      withContext(b, () => {
        expect(currentContext()).toBe(b)
      })
      expect(currentContext()).toBe(a)
    })
  })
})

describe('__resetWindowContextsForTests', () => {
  it('clears the registry, active id and fallback state', () => {
    registerWindow(fakeWin(1))
    withContext(undefined, () => {
      const c: WindowContext = currentContext()
      c.docs.set('stale', {} as never)
      c.workspaceRoot = '/stale'
      c.workspaceSession = 9
    })

    __resetWindowContextsForTests()

    expect(allContexts()).toEqual([])
    expect(activeContext()).toBeUndefined()
    withContext(undefined, () => {
      const c = currentContext()
      expect(c.docs.size).toBe(0)
      expect(c.workspaceRoot).toBeNull()
      expect(c.workspaceSession).toBe(0)
    })
  })
})
