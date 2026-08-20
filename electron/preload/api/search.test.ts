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
  it('query invokes search:query with the query string', () => {
    searchApi.query('hello')
    expect(invokes[0]).toEqual({ channel: 'search:query', args: ['hello'] })
  })
})
