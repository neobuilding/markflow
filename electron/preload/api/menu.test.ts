import { describe, it, expect, vi, beforeEach } from 'vitest'

const sends: Array<{ channel: string; args: unknown[] }> = []
vi.mock('electron', () => ({
  ipcRenderer: {
    send: (channel: string, ...args: unknown[]) => {
      sends.push({ channel, args })
    },
  },
}))

import { menuApi } from './menu'

beforeEach(() => {
  sends.length = 0
})

describe('preload menuApi', () => {
  it('setEditable sends menu:set-editable with the boolean', () => {
    menuApi.setEditable(true)
    expect(sends[0]).toEqual({ channel: 'menu:set-editable', args: [true] })
  })

  it('setHasDocument sends menu:set-has-document with the boolean', () => {
    menuApi.setHasDocument(false)
    expect(sends[0]).toEqual({ channel: 'menu:set-has-document', args: [false] })
  })

  it('setHasFolder sends menu:set-has-folder with the boolean', () => {
    menuApi.setHasFolder(true)
    expect(sends[0]).toEqual({ channel: 'menu:set-has-folder', args: [true] })
  })

  it('setHasDraft sends menu:set-has-draft with the boolean', () => {
    menuApi.setHasDraft(true)
    expect(sends[0]).toEqual({ channel: 'menu:set-has-draft', args: [true] })
  })

  it('setFileLocked sends menu:set-file-locked with the boolean', () => {
    menuApi.setFileLocked(true)
    expect(sends[0]).toEqual({ channel: 'menu:set-file-locked', args: [true] })
  })
})
