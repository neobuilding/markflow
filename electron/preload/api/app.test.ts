import { describe, it, expect, vi, beforeEach } from 'vitest'

const invokes: Array<{ channel: string; args: unknown[] }> = []
const sends: Array<{ channel: string; args: unknown[] }> = []
vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => {
      invokes.push({ channel, args })
      return Promise.resolve()
    },
    send: (channel: string, ...args: unknown[]) => {
      sends.push({ channel, args })
    },
  },
}))

import { appApi } from './app'

beforeEach(() => {
  invokes.length = 0
  sends.length = 0
})

describe('preload appApi', () => {
  it('getTheme / getVersion / getInitialPaths use invoke', () => {
    appApi.getTheme()
    appApi.getVersion()
    appApi.getInitialPaths()
    expect(invokes[0]).toEqual({ channel: 'app:get-theme', args: [] })
    expect(invokes[1]).toEqual({ channel: 'app:get-version', args: [] })
    expect(invokes[2]).toEqual({ channel: 'app:get-initial-paths', args: [] })
  })

  it('setTheme invokes app:set-theme with the theme', () => {
    appApi.setTheme('dark')
    expect(invokes[0]).toEqual({ channel: 'app:set-theme', args: ['dark'] })
  })

  it('showInFolder invokes app:show-in-folder with the path', () => {
    appApi.showInFolder('/a.md')
    expect(invokes[0]).toEqual({ channel: 'app:show-in-folder', args: ['/a.md'] })
  })

  it('setLanguage sends app:set-language (fire-and-forget, use send)', () => {
    appApi.setLanguage('zh-CN')
    expect(sends[0]).toEqual({ channel: 'app:set-language', args: ['zh-CN'] })
    expect(invokes).toHaveLength(0)
  })

  it('allowQuit sends app:quit-allowed (fire-and-forget)', () => {
    appApi.allowQuit()
    expect(sends[0]).toEqual({ channel: 'app:quit-allowed', args: [] })
  })
})
