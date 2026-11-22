// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { registerWindow, currentContext, __resetWindowContextsForTests } from './windowContext'
import { scopedHandleFor, scopedOnFor, runInContext } from './ipcScope'

function fakeWin(id: number): BrowserWindow {
  return { webContents: { id } } as unknown as BrowserWindow
}

type Listener = (event: unknown, ...args: unknown[]) => unknown

function makeBus() {
  const handlers = new Map<string, Listener>()
  return {
    handle: (channel: string, listener: Listener) => {
      handlers.set(channel, listener)
    },
    on: (channel: string, listener: Listener) => {
      handlers.set(channel, listener)
    },
    get: (channel: string) => handlers.get(channel) as Listener,
  }
}

beforeEach(() => {
  __resetWindowContextsForTests()
})

describe('scopedHandleFor', () => {
  it('registers a listener that runs in the requesting window scope', () => {
    const other = registerWindow(fakeWin(2))
    const ctx = registerWindow(fakeWin(1))
    const bus = makeBus()
    const seen: number[] = []

    scopedHandleFor(bus, 'test:scoped', () => {
      seen.push(currentContext().id)
      return 'ok'
    })

    const listener = bus.get('test:scoped')
    const event = { sender: { id: 2 } }
    expect(listener(event)).toBe('ok')
    // The current active window is ctx (id 1, registered last), but the handler resolved to the
    // sender's window (id 2), proving the ALS scope came from event.sender.
    expect(currentContext().id).toBe(ctx.id)
    expect(seen).toEqual([other.id])
  })

  it('falls back to the headless context when invoked with a null event', () => {
    const bus = makeBus()
    let id = -99
    scopedHandleFor(bus, 'test:null', () => {
      id = currentContext().id
    })
    bus.get('test:null')(null)
    expect(id).toBe(-1)
  })

  it('passes additional arguments through to the listener', () => {
    registerWindow(fakeWin(1))
    const bus = makeBus()
    const listener = vi.fn((_event: unknown, a: string, b: number) => `${a}:${b}`)
    scopedHandleFor(bus, 'test:args', listener as Listener)
    expect(bus.get('test:args')({ sender: { id: 1 } }, 'x', 7)).toBe('x:7')
  })
})

describe('scopedOnFor', () => {
  it('registers a scoped event listener on the bus', () => {
    const other = registerWindow(fakeWin(2))
    registerWindow(fakeWin(1))
    const bus = makeBus()
    let id = -99
    scopedOnFor(bus, 'test:on', () => {
      id = currentContext().id
    })
    bus.get('test:on')({ sender: { id: 2 } })
    expect(id).toBe(other.id)
  })
})

describe('runInContext', () => {
  it('runs a non-IPC callback inside the given window scope', () => {
    const ctx = registerWindow(fakeWin(5))
    const result = runInContext(ctx, () => currentContext())
    expect(result).toBe(ctx)
    // Outside the scope the active context is the same here, so also verify the ALS store was
    // actually used by registering a second window afterwards (active switches to it).
    registerWindow(fakeWin(6))
    expect(runInContext(ctx, () => currentContext().id)).toBe(5)
    expect(currentContext().id).toBe(6)
  })
})
