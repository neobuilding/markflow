// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const h = vi.hoisted(() => ({
  on: vi.fn(),
  listener: null as null | ((event: { sender: { id: number } }) => void),
}))
vi.mock('electron', () => ({ ipcMain: { on: h.on } }))
vi.mock('./ipcScope', () => ({
  scopedOnFor: (
    _bus: unknown,
    _channel: string,
    listener: (event: { sender: { id: number } }) => void,
  ) => {
    h.listener = listener
  },
}))

import { markQuitPending } from './quitSignals'
import { registerWindow, __resetWindowContextsForTests } from './windowContext'

function fakeWin(id: number): BrowserWindow {
  return { webContents: { id } } as unknown as BrowserWindow
}

beforeEach(() => {
  __resetWindowContextsForTests()
})

describe('markQuitPending', () => {
  it('disarms only the sending window safety net', () => {
    const sender = registerWindow(fakeWin(7))
    const other = registerWindow(fakeWin(8))

    markQuitPending({ id: 7 })

    expect(sender.quitPending).toBe(true)
    expect(other.quitPending).toBe(false)
  })

  it('never credits an unknown sender to the active window', () => {
    const active = registerWindow(fakeWin(7))

    markQuitPending({ id: 999 })

    // A reply from a destroyed/unknown renderer must not disarm the focused window's net
    // (ADR-0039 §3.4). There is no global mirror any more: only the exact ctx flag moves.
    expect(active.quitPending).toBe(false)
  })

  it('routes the registered app:quit-pending listener by sender', () => {
    const sender = registerWindow(fakeWin(7))
    const other = registerWindow(fakeWin(8))

    expect(h.listener).toBeTypeOf('function')
    h.listener!({ sender: { id: 7 } })

    expect(sender.quitPending).toBe(true)
    expect(other.quitPending).toBe(false)
  })
})
