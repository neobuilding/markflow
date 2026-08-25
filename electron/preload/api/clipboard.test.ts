import { describe, it, expect, vi, beforeEach } from 'vitest'

const invoked: Array<{ channel: string; arg: unknown }> = []
vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: (channel: string, arg: unknown) => {
      invoked.push({ channel, arg })
      return Promise.resolve('ok')
    },
  },
}))

import { clipboardApi } from './clipboard'

beforeEach(() => {
  invoked.length = 0
})

describe('preload clipboard bridge', () => {
  it('writeText invokes clipboard:write-text with the text', () => {
    clipboardApi.writeText('/foo/bar.md')
    expect(invoked).toEqual([{ channel: 'clipboard:write-text', arg: '/foo/bar.md' }])
  })

  it('writeText forwards an empty string', () => {
    clipboardApi.writeText('')
    expect(invoked).toEqual([{ channel: 'clipboard:write-text', arg: '' }])
  })

  it('writeText returns the resolved value from the main process', async () => {
    const result = await clipboardApi.writeText('payload')
    expect(result).toBe('ok')
  })
})
