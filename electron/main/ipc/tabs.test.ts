// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { TabHandoff } from '../../../shared/tabTypes'
import { __resetWindowContextsForTests, registerWindow } from '../model/windowContext'
import { createMemoryDiskIO, type MemoryDiskIO } from '../lib/disk-io'
import { registerTabsHandlers, dragSessions } from './tabs'

const h = vi.hoisted(() => ({ createWindow: vi.fn() }))
vi.mock('../window', () => ({ createWindow: h.createWindow }))

type Listener = (event: unknown, ...args: unknown[]) => unknown

function makeBus() {
  const handlers = new Map<string, Listener>()
  return {
    handle: (channel: string, listener: Listener) => handlers.set(channel, listener),
    get: (channel: string) => handlers.get(channel) as Listener,
  }
}

function fakeWin(
  id: number,
  title = `Window ${id}`,
  state: { destroyed?: boolean; minimized?: boolean } = {},
) {
  const sent: Array<{ channel: string; payload: unknown }> = []
  let minimized = state.minimized ?? false
  const win = {
    webContents: {
      id,
      send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    },
    isDestroyed: () => state.destroyed ?? false,
    isMinimized: () => minimized,
    restore: () => {
      minimized = false
    },
    focus: () => {},
    getTitle: () => title,
  } as unknown as BrowserWindow
  return { ctx: registerWindow(win), sent }
}

const handoff = (overrides: Partial<TabHandoff> = {}): TabHandoff => ({
  tabId: 'tab-1',
  documentId: 'doc-1',
  filePath: 'C:/notes/a.md',
  content: null,
  title: 'a.md',
  external: false,
  isNewUnsaved: false,
  eol: '\n',
  history: [{ path: 'C:/notes/a.md' }],
  cursor: 0,
  ...overrides,
})

let io: MemoryDiskIO
let bus: ReturnType<typeof makeBus>

beforeEach(() => {
  __resetWindowContextsForTests()
  h.createWindow.mockClear()
  // Reset the shared registry between tests by consuming all known tokens.
  for (const token of ['t1', 't2', 't3', 't4', 't6']) dragSessions.cancel(token)
  io = createMemoryDiskIO()
  io.seed('C:/notes/a.md', '# A')
  bus = makeBus()
  registerTabsHandlers(bus as never, io)
})

describe('tabs IPC (ADR-0040)', () => {
  it('begin-drag resolves the source by exact sender and refuses unknown senders', async () => {
    const { ctx } = fakeWin(11)
    const first = (await bus.get('tabs:begin-drag')({ sender: { id: ctx.id } }, handoff())) as {
      token: string
    }
    expect(first.token).toBeTruthy()
    const unknown = (await bus.get('tabs:begin-drag')({ sender: { id: 999 } }, handoff())) as {
      token: string
    }
    expect(unknown.token).toBe('')
  })

  it('begin-drag refuses a file-backed handoff whose file is missing or not Markdown', async () => {
    const { ctx } = fakeWin(12)
    const missing = (await bus.get('tabs:begin-drag')(
      { sender: { id: ctx.id } },
      handoff({ filePath: 'C:/notes/gone.md' }),
    )) as { token: string }
    expect(missing.token).toBe('')
    const wrongExt = (await bus.get('tabs:begin-drag')(
      { sender: { id: ctx.id } },
      handoff({ filePath: 'C:/notes/a.png' }),
    )) as { token: string }
    expect(wrongExt.token).toBe('')
  })

  it('same-window drop returns same-window without consuming the token', async () => {
    const { ctx } = fakeWin(21)
    const { token } = (await bus.get('tabs:begin-drag')({ sender: { id: ctx.id } }, handoff())) as {
      token: string
    }
    expect(await bus.get('tabs:drop')({ sender: { id: ctx.id } }, { token, index: 0 })).toBe(
      'same-window',
    )
    expect(dragSessions.get(token)?.state).toBe('active')
  })

  it('cross-window drop consumes, delivers handoff to the target, and ACK releases source', async () => {
    const source = fakeWin(31)
    const target = fakeWin(32)
    const { token } = (await bus.get('tabs:begin-drag')(
      { sender: { id: source.ctx.id } },
      handoff({ title: 'a*.md', content: 'draft' }),
    )) as { token: string }
    expect(await bus.get('tabs:drop')({ sender: { id: target.ctx.id } }, { token, index: 1 })).toBe(
      'consumed',
    )
    expect(target.sent).toContainEqual({
      channel: 'app:tab-accept',
      payload: {
        token,
        handoff: expect.objectContaining({ tabId: 'tab-1', title: 'a*.md', content: 'draft' }),
      },
    })
    // Before ACK the source is untouched.
    expect(source.sent).toEqual([])
    await bus.get('tabs:accept-ack')({ sender: { id: target.ctx.id } }, { token })
    expect(source.sent).toContainEqual({
      channel: 'app:tab-remove',
      payload: { tabId: 'tab-1' },
    })
  })

  it('unknown / expired tokens report no-session / expired and do not send events', async () => {
    const { ctx } = fakeWin(41)
    expect(
      await bus.get('tabs:drop')({ sender: { id: ctx.id } }, { token: 'never', index: 0 }),
    ).toBe('no-session')
    const { token } = (await bus.get('tabs:begin-drag')({ sender: { id: ctx.id } }, handoff())) as {
      token: string
    }
    await bus.get('tabs:detach')({ sender: { id: ctx.id } }, { token })
    expect(await bus.get('tabs:detach')({ sender: { id: ctx.id } }, { token })).toBe('expired')
  })

  it('detach creates a new window with workspaceRoot but no pendingPaths', async () => {
    const { ctx } = fakeWin(51)
    const { token } = (await bus.get('tabs:begin-drag')({ sender: { id: ctx.id } }, handoff())) as {
      token: string
    }
    await bus.get('tabs:detach')({ sender: { id: ctx.id } }, { token })
    expect(h.createWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: 'C:/notes',
        tabHandoff: expect.objectContaining({ token }),
      }),
    )
    expect(h.createWindow.mock.calls[0][0]).not.toHaveProperty('filePath')
  })

  it('detach of a memory-only draft omits workspaceRoot', async () => {
    const { ctx } = fakeWin(55)
    const { token } = (await bus.get('tabs:begin-drag')(
      { sender: { id: ctx.id } },
      handoff({ filePath: '' }),
    )) as { token: string }
    await bus.get('tabs:detach')({ sender: { id: ctx.id } }, { token })
    expect(h.createWindow.mock.calls[0][0].workspaceRoot).toBeUndefined()
  })

  it('take-handoff is one-shot and scoped to the requesting window', async () => {
    const first = fakeWin(61)
    const other = fakeWin(62)
    const { token } = (await bus.get('tabs:begin-drag')(
      { sender: { id: first.ctx.id } },
      handoff(),
    )) as { token: string }
    await bus.get('tabs:detach')({ sender: { id: first.ctx.id } }, { token })
    first.ctx.pendingTabHandoff = { token, handoff: handoff() }
    expect(await bus.get('tabs:take-handoff')({ sender: { id: other.ctx.id } })).toBeNull()
    const taken = await bus.get('tabs:take-handoff')({ sender: { id: first.ctx.id } })
    expect(taken).toEqual({ token, handoff: handoff() })
    expect(first.ctx.pendingTabHandoff).toBeUndefined()
    expect(await bus.get('tabs:take-handoff')({ sender: { id: first.ctx.id } })).toBeNull()
  })

  it('move-to-window reuses the drop path; list-windows excludes requester', async () => {
    const source = fakeWin(71)
    const target = fakeWin(72, 'Target')
    const { token } = (await bus.get('tabs:begin-drag')(
      { sender: { id: source.ctx.id } },
      handoff(),
    )) as { token: string }
    expect(
      await bus.get('tabs:move-to-window')(
        { sender: { id: source.ctx.id } },
        { token, targetWindowId: target.ctx.id },
      ),
    ).toBe('consumed')
    expect(target.sent[0].channel).toBe('app:tab-accept')
    // A same-window move does not deliver a handoff.
    const { token: localToken } = (await bus.get('tabs:begin-drag')(
      { sender: { id: source.ctx.id } },
      handoff(),
    )) as { token: string }
    expect(
      await bus.get('tabs:move-to-window')(
        { sender: { id: source.ctx.id } },
        { token: localToken, targetWindowId: source.ctx.id },
      ),
    ).toBe('same-window')
    const windows = await bus.get('tabs:list-windows')({ sender: { id: source.ctx.id } })
    expect(windows).toEqual([{ id: target.ctx.id, title: 'Target' }])
    // Unknown requester: no context is excluded, so every window is listed.
    const all = await bus.get('tabs:list-windows')({ sender: { id: 999 } })
    expect(all).toContainEqual({ id: source.ctx.id, title: 'Window 71' })
  })

  it('drop with an unknown sender returns no-session; minimized/destroyed targets are safe', async () => {
    expect(await bus.get('tabs:drop')({ sender: { id: 999 } }, { token: 'x', index: 0 })).toBe(
      'no-session',
    )
    const source = fakeWin(91)
    const minimized = fakeWin(92, 'Min', { minimized: true })
    const { token } = (await bus.get('tabs:begin-drag')(
      { sender: { id: source.ctx.id } },
      handoff(),
    )) as { token: string }
    expect(
      await bus.get('tabs:drop')({ sender: { id: minimized.ctx.id } }, { token, index: 0 }),
    ).toBe('consumed')
    expect(minimized.sent).toHaveLength(1)
  })

  it('drop to a destroyed target still consumes without delivering', async () => {
    const source = fakeWin(93)
    const dead = fakeWin(94, 'Dead', { destroyed: true })
    const { token } = (await bus.get('tabs:begin-drag')(
      { sender: { id: source.ctx.id } },
      handoff(),
    )) as { token: string }
    expect(await bus.get('tabs:drop')({ sender: { id: dead.ctx.id } }, { token, index: 0 })).toBe(
      'consumed',
    )
    expect(dead.sent).toEqual([])
  })

  it('accept-ack does not send to a destroyed source window', async () => {
    const source = fakeWin(95, 'Dead', { destroyed: true })
    const target = fakeWin(96)
    const { token } = (await bus.get('tabs:begin-drag')(
      { sender: { id: source.ctx.id } },
      handoff(),
    )) as { token: string }
    await bus.get('tabs:drop')({ sender: { id: target.ctx.id } }, { token, index: 0 })
    bus.get('tabs:accept-ack')({ sender: { id: target.ctx.id } }, { token })
    expect(source.sent).toEqual([])
  })

  it('cancel-drag consumes an active session; accept-ack ignores unknown tokens', async () => {
    const { ctx } = fakeWin(81)
    const { token } = (await bus.get('tabs:begin-drag')({ sender: { id: ctx.id } }, handoff())) as {
      token: string
    }
    await bus.get('tabs:cancel-drag')({ sender: { id: ctx.id } }, { token })
    expect(dragSessions.get(token)?.state).toBe('consumed')
    expect(
      bus.get('tabs:accept-ack')({ sender: { id: ctx.id } }, { token: 'never' }),
    ).toBeUndefined()
  })
})
