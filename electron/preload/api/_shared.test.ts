import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock ipcRenderer so we can assert onIpc wires listeners correctly without Electron.
const listeners: Record<string, (...args: unknown[]) => void> = {}
const h = vi.hoisted(() => ({
  ipcArgs: [] as unknown[],
}))
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

import { onIpc } from './_shared'

beforeEach(() => {
  for (const k of Object.keys(listeners)) delete listeners[k]
  h.ipcArgs.length = 0
})

describe('preload _shared onIpc', () => {
  it('registers an ipcRenderer listener on the given channel', () => {
    onIpc('menu:save', () => {})
    expect(typeof listeners['menu:save']).toBe('function')
  })

  it('forwards renderer callback args (the first payload arg, after the event)', () => {
    let received: unknown
    onIpc('app:open-paths', (paths) => {
      received = paths
    })
    // ipcRenderer delivers (event, ...args); onIpc strips the event.
    listeners['app:open-paths']({}, ['/a.md', '/b.md'])
    expect(received).toEqual(['/a.md', '/b.md'])
  })

  it('returns an unsubscribe that removes the listener', () => {
    const off = onIpc('menu:reload', () => {})
    expect(typeof listeners['menu:reload']).toBe('function')
    off()
    expect(listeners['menu:reload']).toBeUndefined()
  })

  it('does not collide channels across subscriptions', () => {
    onIpc('a', () => {})
    onIpc('b', () => {})
    expect(Object.keys(listeners).sort()).toEqual(['a', 'b'])
  })
})
