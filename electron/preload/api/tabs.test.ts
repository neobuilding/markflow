// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke, on } = vi.hoisted(() => ({
  invoke: vi.fn(async () => ({})),
  on: vi.fn(() => () => {}),
}))

vi.mock('electron', () => ({
  ipcRenderer: { invoke, on, removeListener: vi.fn() },
}))

import { onTabAccept, onTabRemove, tabsApi } from './tabs'
import type { TabHandoff } from '../../../shared/tabTypes'

const handoff: TabHandoff = {
  tabId: 't',
  documentId: 'd',
  filePath: '/a.md',
  workspaceRoot: '',
  content: null,
  title: 'a.md',
  external: false,
  isNewUnsaved: false,
  eol: '\n',
  history: [],
  cursor: -1,
}

describe('preload/api/tabs (ADR-0040)', () => {
  beforeEach(() => {
    invoke.mockClear()
    on.mockClear()
  })

  it('invokes every channel with the documented payload', async () => {
    await tabsApi.beginDrag(handoff, 'sync-token')
    expect(invoke).toHaveBeenCalledWith('tabs:begin-drag', handoff, 'sync-token')
    await tabsApi.drop('tok', 2)
    expect(invoke).toHaveBeenCalledWith('tabs:drop', { token: 'tok', index: 2 })
    await tabsApi.detach('tok')
    expect(invoke).toHaveBeenCalledWith('tabs:detach', { token: 'tok' })
    await tabsApi.cancelDrag('tok')
    expect(invoke).toHaveBeenCalledWith('tabs:cancel-drag', { token: 'tok' })
    await tabsApi.takeHandoff()
    expect(invoke).toHaveBeenCalledWith('tabs:take-handoff')
    await tabsApi.acceptAck('tok')
    expect(invoke).toHaveBeenCalledWith('tabs:accept-ack', { token: 'tok' })
    await tabsApi.moveToWindow('tok', 7, 1)
    expect(invoke).toHaveBeenCalledWith('tabs:move-to-window', {
      token: 'tok',
      targetWindowId: 7,
      index: 1,
    })
    await tabsApi.listWindows()
    expect(invoke).toHaveBeenCalledWith('tabs:list-windows')
  })

  it('subscribes to main-to-renderer events with onIpc', () => {
    const off = onTabAccept(() => {})
    expect(on).toHaveBeenCalledWith('app:tab-accept', expect.any(Function))
    expect(typeof off).toBe('function')
    const off2 = onTabRemove(() => {})
    expect(on).toHaveBeenCalledWith('app:tab-remove', expect.any(Function))
    expect(typeof off2).toBe('function')
  })
})
