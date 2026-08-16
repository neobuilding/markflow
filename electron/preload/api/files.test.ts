import { describe, it, expect, vi, beforeEach } from 'vitest'

const invokes: Array<{ channel: string; args: unknown[] }> = []
const h = vi.hoisted(() => ({
  webUtilsPath: '/virtual/path/from/webutils',
  shouldThrow: false,
}))
vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => {
      invokes.push({ channel, args })
      return Promise.resolve()
    },
  },
  webUtils: {
    getPathForFile: () => {
      if (h.shouldThrow) throw new Error('nope')
      return h.webUtilsPath
    },
  },
}))

import { filesApi } from './files'

beforeEach(() => {
  invokes.length = 0
  h.shouldThrow = false
})

describe('preload filesApi', () => {
  it('resolvePaths invokes files:resolve-paths with the path array', () => {
    filesApi.resolvePaths(['/a.md', '/b'])
    expect(invokes[0]).toEqual({ channel: 'files:resolve-paths', args: [['/a.md', '/b']] })
  })

  it('getPathForFile delegates to webUtils.getPathForFile', () => {
    const fakeFile = { name: 'doc.md' } as File
    const result = filesApi.getPathForFile(fakeFile)
    expect(result).toBe(h.webUtilsPath)
  })

  it('getPathForFile returns empty string if webUtils.getPathForFile throws', () => {
    h.shouldThrow = true
    const fakeFile = { name: 'doc.md' } as File
    expect(filesApi.getPathForFile(fakeFile)).toBe('')
  })
})
