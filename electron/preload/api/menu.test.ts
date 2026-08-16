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

  it('setPrinting sends menu:set-printing with the boolean', () => {
    menuApi.setPrinting(true)
    expect(sends[0]).toEqual({ channel: 'menu:set-printing', args: [true] })
  })
})
