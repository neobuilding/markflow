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

import { searchApi } from './search'

beforeEach(() => {
  invokes.length = 0
})

describe('preload searchApi', () => {
  it('query invokes search:query with the query and default scope/mode', () => {
    searchApi.query('hello')
    expect(invokes[0]).toEqual({
      channel: 'search:query',
      args: [{ query: 'hello', scopeFolder: null, mode: 'content' }],
    })
  })

  it('forwards an explicit scope folder and mode', () => {
    searchApi.query('hello', { scopeFolder: '/docs', mode: 'filename' })
    expect(invokes[0]).toEqual({
      channel: 'search:query',
      args: [{ query: 'hello', scopeFolder: '/docs', mode: 'filename' }],
    })
  })
})
