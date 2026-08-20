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

import { exportApi } from './export'

beforeEach(() => {
  invokes.length = 0
})

describe('preload exportApi', () => {
  it('embedImages invokes export:embed-images with the html', () => {
    exportApi.embedImages('<p>x</p>')
    expect(invokes[0]).toEqual({ channel: 'export:embed-images', args: ['<p>x</p>'] })
  })

  it('write invokes export:write with path, html, and the default overwrite flag', () => {
    exportApi.write('/o.html', '<p>x</p>')
    expect(invokes[0]).toEqual({ channel: 'export:write', args: ['/o.html', '<p>x</p>', false] })
  })

  it('write passes the overwrite flag through when true', () => {
    exportApi.write('/o.html', '<p>x</p>', true)
    expect(invokes[0]).toEqual({ channel: 'export:write', args: ['/o.html', '<p>x</p>', true] })
  })

  it('print invokes export:print with the html', () => {
    exportApi.print('<h1>x</h1>')
    expect(invokes[0]).toEqual({ channel: 'export:print', args: ['<h1>x</h1>'] })
  })
})
