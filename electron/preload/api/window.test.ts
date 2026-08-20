import { describe, it, expect, vi, beforeEach } from 'vitest'

const invokes: Array<{ channel: string; args: unknown[] }> = []
vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => {
      invokes.push({ channel, args })
      return Promise.resolve()
    },
  },
}))

import { windowApi } from './window'

beforeEach(() => {
  invokes.length = 0
})

describe('preload windowApi', () => {
  it('maximize invokes window:maximize', () => {
    windowApi.maximize()
    expect(invokes[0]).toEqual({ channel: 'window:maximize', args: [] })
  })

  it('unmaximize invokes window:unmaximize', () => {
    windowApi.unmaximize()
    expect(invokes[0]).toEqual({ channel: 'window:unmaximize', args: [] })
  })

  it('isMaximized invokes window:is-maximized', () => {
    windowApi.isMaximized()
    expect(invokes[0]).toEqual({ channel: 'window:is-maximized', args: [] })
  })
})
