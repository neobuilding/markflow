import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture channel registrations for the renderer→main event subscriptions.
const listeners: Record<string, (...args: unknown[]) => void> = {}
vi.mock('electron', () => ({
  ipcRenderer: {
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      listeners[channel] = listener
    },
    removeListener: vi.fn((channel: string) => {
      delete listeners[channel]
    }),
  },
}))

import {
  onMenuEvent,
  onFileChanged,
  onOpenPaths,
  onAppRequestQuit,
  onFolderChanged,
  onDocumentRefresh,
} from './events'

beforeEach(() => {
  for (const k of Object.keys(listeners)) delete listeners[k]
})

describe('preload events subscriptions', () => {
  it('onMenuEvent maps each menu event to menu:<event> and forwards the payload', () => {
    let payload: unknown
    onMenuEvent('save', (data) => {
      payload = data
    })
    expect(typeof listeners['menu:save']).toBe('function')
    listeners['menu:save']({}, 'data-1')
    expect(payload).toBe('data-1')
  })

  it('onMenuEvent forwards an array payload (e.g. open-files)', () => {
    let payload: unknown
    onMenuEvent('open-files', (data) => {
      payload = data
    })
    listeners['menu:open-files']({}, ['/x.md'])
    expect(payload).toEqual(['/x.md'])
  })

  it('onFileChanged maps to app:file-changed and forwards the change object', () => {
    let payload: unknown
    onFileChanged((data) => {
      payload = data
    })
    expect(typeof listeners['app:file-changed']).toBe('function')
    const change = { id: 'd1', filePath: '/d.md' }
    listeners['app:file-changed']({}, change)
    expect(payload).toEqual(change)
  })

  it('onOpenPaths maps to app:open-paths and forwards the path list', () => {
    let payload: unknown
    onOpenPaths((paths) => {
      payload = paths
    })
    expect(typeof listeners['app:open-paths']).toBe('function')
    listeners['app:open-paths']({}, ['/a.md', '/b.md'])
    expect(payload).toEqual(['/a.md', '/b.md'])
  })

  it('onAppRequestQuit maps to app:request-quit with no payload', () => {
    let called = false
    onAppRequestQuit(() => {
      called = true
    })
    expect(typeof listeners['app:request-quit']).toBe('function')
    listeners['app:request-quit']({})
    expect(called).toBe(true)
  })

  it('onFolderChanged maps to app:folder-changed and forwards the dirPath', () => {
    let payload: unknown
    onFolderChanged((data) => {
      payload = data
    })
    expect(typeof listeners['app:folder-changed']).toBe('function')
    const change = { dirPath: '/docs' }
    listeners['app:folder-changed']({}, change)
    expect(payload).toEqual(change)
  })

  it('onDocumentRefresh maps to app:document-refresh and forwards the id', () => {
    let payload: unknown
    onDocumentRefresh((data) => {
      payload = data
    })
    expect(typeof listeners['app:document-refresh']).toBe('function')
    const change = { id: 'd1' }
    listeners['app:document-refresh']({}, change)
    expect(payload).toEqual(change)
  })
})
