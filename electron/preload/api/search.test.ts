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
  it('query forwards the frozen envelope verbatim (filename mode)', () => {
    searchApi.query({ query: 'hello', mode: 'filename' })
    expect(invokes[0]).toEqual({
      channel: 'search:query',
      args: [{ query: 'hello', mode: 'filename' }],
    })
  })

  it('forwards scope, matchCase and the dirty-state contract (content mode)', () => {
    searchApi.query({
      query: 'hello',
      mode: 'content',
      include: './docs',
      exclude: './archive',
      matchCase: true,
      dirtyDocumentSnapshots: [{ documentId: 'a', content: 'x', revision: 2 }],
      documentStateRevision: 7,
    })
    expect(invokes[0].args[0]).toEqual({
      query: 'hello',
      mode: 'content',
      include: './docs',
      exclude: './archive',
      matchCase: true,
      dirtyDocumentSnapshots: [{ documentId: 'a', content: 'x', revision: 2 }],
      documentStateRevision: 7,
    })
  })
})
