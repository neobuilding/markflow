// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { registerWindow, __resetWindowContextsForTests } from '../model/windowContext'
import { createMemoryDiskIO, type MemoryDiskIO } from '../lib/disk-io'
import { registerNewWindowHandlers } from './newWindow'

// `app:open-in-new-window` opens a Markdown file in its own window. The interesting decisions are
// the reuse rule (a window whose workspace already contains the file is the better home) and the
// refusals (a missing file, a non-Markdown file). The filesystem check runs through the DiskIO
// port, so no real disk is involved (docs/agents/testing.md).

const h = vi.hoisted(() => ({ createWindow: vi.fn() }))
vi.mock('../window', () => ({ createWindow: h.createWindow }))

type Listener = (event: unknown, ...args: unknown[]) => unknown

function makeBus() {
  const handlers = new Map<string, Listener>()
  return {
    handle: (channel: string, listener: Listener) => {
      handlers.set(channel, listener)
    },
    get: (channel: string) => handlers.get(channel) as Listener,
  }
}

interface FakeWinState {
  destroyed: boolean
  minimized: boolean
  restored: boolean
  focused: boolean
  sent: Array<{ channel: string; payload: unknown }>
}

function fakeWin(id: number): { win: BrowserWindow; state: FakeWinState } {
  const state: FakeWinState = {
    destroyed: false,
    minimized: false,
    restored: false,
    focused: false,
    sent: [],
  }
  const win = {
    webContents: {
      id,
      send: (channel: string, payload: unknown) => state.sent.push({ channel, payload }),
    },
    isDestroyed: () => state.destroyed,
    isMinimized: () => state.minimized,
    restore: () => {
      state.restored = true
      state.minimized = false
    },
    focus: () => {
      state.focused = true
    },
  } as unknown as BrowserWindow
  return { win, state }
}

let io: MemoryDiskIO
let bus: ReturnType<typeof makeBus>

function open(path: string): unknown {
  return bus.get('app:open-in-new-window')({ sender: { id: 1 } }, path)
}

beforeEach(() => {
  __resetWindowContextsForTests()
  h.createWindow.mockClear()
  io = createMemoryDiskIO()
  bus = makeBus()
  registerNewWindowHandlers(bus as never, io)
})

describe('app:open-in-new-window', () => {
  it('refuses an empty path', () => {
    expect(open('')).toBe(false)
    expect(h.createWindow).not.toHaveBeenCalled()
  })

  it('refuses a path that is not a Markdown file', () => {
    io.seed('C:/notes/photo.png', 'x')
    expect(open('C:/notes/photo.png')).toBe(false)
    expect(h.createWindow).not.toHaveBeenCalled()
  })

  it('refuses a file that does not exist', () => {
    expect(open('C:/notes/missing.md')).toBe(false)
    expect(h.createWindow).not.toHaveBeenCalled()
  })

  it('creates a window whose workspace is the file parent folder', () => {
    io.seed('C:/notes/deep/picked.md', '# Picked')
    expect(open('C:/notes/deep/picked.md')).toBe(true)
    expect(h.createWindow).toHaveBeenCalledWith({
      workspaceRoot: 'C:/notes/deep',
      filePath: 'C:/notes/deep/picked.md',
    })
  })

  it('reuses a window whose workspace already contains the file', () => {
    io.seed('C:/notes/picked.md', '# Picked')
    const { win, state } = fakeWin(7)
    const ctx = registerWindow(win)
    ctx.workspaceRoot = 'C:/notes'

    expect(open('C:/notes/picked.md')).toBe(true)
    // Reuse means FOCUS, not a second window: the file belongs to the window that watches it.
    expect(h.createWindow).not.toHaveBeenCalled()
    expect(state.focused).toBe(true)
    expect(state.sent).toEqual([{ channel: 'app:reveal-file', payload: 'C:/notes/picked.md' }])
  })

  it('creates a new window instead of silently reusing the requesting window', () => {
    io.seed('C:/notes/picked.md', '# Picked')
    const { win, state } = fakeWin(1)
    const ctx = registerWindow(win)
    ctx.workspaceRoot = 'C:/notes'

    expect(open('C:/notes/picked.md')).toBe(true)
    // "Open in new window" must produce a visible change. Reusing the sender itself is a no-op:
    // it is already focused and the file is already revealed there, so the user sees nothing.
    expect(h.createWindow).toHaveBeenCalledWith({
      workspaceRoot: 'C:/notes',
      filePath: 'C:/notes/picked.md',
    })
    expect(state.focused).toBe(false)
    expect(state.sent).toEqual([])
  })

  it('restores a minimized window before focusing it', () => {
    io.seed('C:/notes/picked.md', '# Picked')
    const { win, state } = fakeWin(7)
    const ctx = registerWindow(win)
    ctx.workspaceRoot = 'C:/notes'
    state.minimized = true

    expect(open('C:/notes/picked.md')).toBe(true)
    expect(state.restored).toBe(true)
    expect(state.focused).toBe(true)
  })

  it('creates a new window when the matching one is already destroyed', () => {
    io.seed('C:/notes/picked.md', '# Picked')
    const { win, state } = fakeWin(7)
    const ctx = registerWindow(win)
    ctx.workspaceRoot = 'C:/notes'
    state.destroyed = true

    expect(open('C:/notes/picked.md')).toBe(true)
    expect(h.createWindow).toHaveBeenCalledTimes(1)
    expect(state.focused).toBe(false)
  })

  it('creates a new window when no window has a workspace root', () => {
    io.seed('C:/notes/picked.md', '# Picked')
    registerWindow(fakeWin(7).win)
    expect(open('C:/notes/picked.md')).toBe(true)
    expect(h.createWindow).toHaveBeenCalledTimes(1)
  })
})
