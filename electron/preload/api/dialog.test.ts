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

import { dialogApi } from './dialog'

beforeEach(() => {
  invokes.length = 0
})

describe('preload dialogApi', () => {
  it('openFiles invokes dialog:open-files', () => {
    dialogApi.openFiles()
    expect(invokes[0]).toEqual({ channel: 'dialog:open-files', args: [] })
  })

  it('openFolder invokes dialog:open-folder', () => {
    dialogApi.openFolder()
    expect(invokes[0]).toEqual({ channel: 'dialog:open-folder', args: [] })
  })

  it('openFolderPath invokes dialog:select-folder', () => {
    dialogApi.openFolderPath()
    expect(invokes[0]).toEqual({ channel: 'dialog:select-folder', args: [] })
  })

  it('saveFile invokes dialog:save-file with optional default path', () => {
    dialogApi.saveFile('/def.md')
    expect(invokes[0]).toEqual({ channel: 'dialog:save-file', args: ['/def.md'] })
  })

  it('saveHtmlFile invokes dialog:save-html with optional default path', () => {
    dialogApi.saveHtmlFile()
    expect(invokes[0]).toEqual({ channel: 'dialog:save-html', args: [undefined] })
  })

  it('confirm invokes dialog:confirm with the opts object', () => {
    const opts = { message: 'Sure?', okText: 'OK' }
    dialogApi.confirm(opts)
    expect(invokes[0]).toEqual({ channel: 'dialog:confirm', args: [opts] })
  })
})
