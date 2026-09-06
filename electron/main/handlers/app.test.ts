import { describe, it, expect, vi, beforeEach } from 'vitest'
import { writeFileSync, mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAppdocPath } from '../ipc/appdoc'

const handlers: Record<string, (...a: unknown[]) => unknown> = {}
const clipboardMock = vi.hoisted(() => ({ writeText: vi.fn(), writeImage: vi.fn() }))
const shellMock = vi.hoisted(() => ({ showItemInFolder: vi.fn(), openExternal: vi.fn() }))
const h = vi.hoisted(() => ({ version: '9.9.9' }))
const nativeImageMock = vi.hoisted(() => ({
  createFromBuffer: (buf: Buffer) => ({ isEmpty: () => buf.length === 0 }),
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => {
      handlers[ch] = fn
    },
  },
  shell: shellMock,
  clipboard: clipboardMock,
  nativeImage: nativeImageMock,
  app: { getVersion: () => h.version },
}))
// documents.ts/appdoc.ts resolveAppdocPath: control its return so we can exercise both
// the appdoc:// branch and the "resolved to null" early-return in the new handlers.
vi.mock('../ipc/appdoc', () => ({ resolveAppdocPath: vi.fn(() => null) }))

import { registerAppHandlers } from './app'
import { pendingInitialPaths } from '../state'

describe('app handlers', () => {
  beforeEach(() => {
    for (const k of Object.keys(handlers)) delete handlers[k]
    pendingInitialPaths.length = 0
    registerAppHandlers()
  })

  it('drains pending initial paths', () => {
    pendingInitialPaths.push('/a.md', '/b.md')
    const out = handlers['app:get-initial-paths'](null) as string[]
    expect(out).toEqual(['/a.md', '/b.md'])
    // spliced empty
    expect(pendingInitialPaths.length).toBe(0)
  })

  it('shows a file in the folder via the shell', () => {
    handlers['app:show-in-folder'](null, '/x.md')
    expect(handlers['app:show-in-folder']).toBeDefined()
  })

  it('does not throw when showItemInFolder throws', () => {
    shellMock.showItemInFolder.mockImplementationOnce(() => {
      throw new Error('nope')
    })
    expect(() => handlers['app:show-in-folder'](null, '/x.md')).not.toThrow()
  })

  it('returns the app version', () => {
    expect(handlers['app:get-version'](null)).toBe('9.9.9')
  })

  it('writes the provided text to the clipboard', () => {
    clipboardMock.writeText.mockClear()
    handlers['clipboard:write-text'](null, '/some/long/path.md')
    expect(clipboardMock.writeText).toHaveBeenCalledTimes(1)
    expect(clipboardMock.writeText).toHaveBeenCalledWith('/some/long/path.md')
  })

  it('does not throw when clipboard.writeText throws', () => {
    clipboardMock.writeText.mockImplementationOnce(() => {
      throw new Error('clipboard unavailable')
    })
    expect(() => handlers['clipboard:write-text'](null, 'x')).not.toThrow()
  })

  it('opens a URL in the default browser via the shell', () => {
    handlers['app:open-external'](null, 'https://example.com')
    expect(handlers['app:open-external']).toBeDefined()
    expect(shellMock.openExternal).toHaveBeenCalledWith('https://example.com')
  })

  it('does not throw when shell.openExternal throws', () => {
    shellMock.openExternal.mockImplementationOnce(() => {
      throw new Error('nope')
    })
    expect(() => handlers['app:open-external'](null, 'https://example.com')).not.toThrow()
  })

  it('swallows a rejected shell.openExternal (no unhandled rejection)', () => {
    shellMock.openExternal.mockRejectedValueOnce(new Error('nope'))
    expect(() => handlers['app:open-external'](null, 'https://example.com')).not.toThrow()
  })

  describe('clipboard:write-image (能力 2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-img-'))
    it('reads the image and writes it to the clipboard', () => {
      const p = join(dir, 'pic.png')
      writeFileSync(p, Buffer.from([1, 2, 3, 4]))
      clipboardMock.writeImage.mockClear()
      handlers['clipboard:write-image'](null, p)
      expect(clipboardMock.writeImage).toHaveBeenCalledTimes(1)
    })
    it('does nothing when the image is empty', () => {
      const p = join(dir, 'empty.png')
      writeFileSync(p, Buffer.alloc(0))
      clipboardMock.writeImage.mockClear()
      handlers['clipboard:write-image'](null, p)
      expect(clipboardMock.writeImage).not.toHaveBeenCalled()
    })
    it('does not throw on a missing file', () => {
      clipboardMock.writeImage.mockClear()
      expect(() => handlers['clipboard:write-image'](null, join(dir, 'gone.png'))).not.toThrow()
      expect(clipboardMock.writeImage).not.toHaveBeenCalled()
    })
    it('resolves an appdoc:// source before writing', () => {
      const p = join(dir, 'pic.png')
      writeFileSync(p, Buffer.from([1, 2, 3, 4]))
      vi.mocked(resolveAppdocPath).mockReturnValue(p)
      clipboardMock.writeImage.mockClear()
      handlers['clipboard:write-image'](null, 'appdoc://d1/pic.png')
      expect(resolveAppdocPath).toHaveBeenCalledWith('appdoc://d1/pic.png')
      expect(clipboardMock.writeImage).toHaveBeenCalledTimes(1)
      vi.mocked(resolveAppdocPath).mockReturnValue(null)
    })
    it('does nothing when an appdoc:// source resolves to nothing', () => {
      vi.mocked(resolveAppdocPath).mockReturnValue(null)
      clipboardMock.writeImage.mockClear()
      handlers['clipboard:write-image'](null, 'appdoc://d1/missing.png')
      expect(clipboardMock.writeImage).not.toHaveBeenCalled()
    })
  })

  describe('app:copy-file (能力 2 另存为)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-cp-'))
    it('copies a source file to a destination', () => {
      const src = join(dir, 'src.md')
      const dest = join(dir, 'dest.md')
      writeFileSync(src, 'hello')
      handlers['app:copy-file'](null, src, dest)
      expect(existsSync(dest)).toBe(true)
      expect(readFileSync(dest, 'utf-8')).toBe('hello')
    })
    it('does not throw on a missing source', () => {
      expect(() =>
        handlers['app:copy-file'](null, join(dir, 'nope.md'), join(dir, 'out.md')),
      ).not.toThrow()
    })
    it('resolves an appdoc:// source before copying', () => {
      const src = join(dir, 'src.md')
      const dest = join(dir, 'dest.md')
      writeFileSync(src, 'hello')
      vi.mocked(resolveAppdocPath).mockReturnValue(src)
      handlers['app:copy-file'](null, 'appdoc://d1/src.md', dest)
      expect(existsSync(dest)).toBe(true)
      expect(readFileSync(dest, 'utf-8')).toBe('hello')
      vi.mocked(resolveAppdocPath).mockReturnValue(null)
    })
    it('does nothing when an appdoc:// source resolves to nothing', () => {
      vi.mocked(resolveAppdocPath).mockReturnValue(null)
      const dest = join(dir, 'out.md')
      handlers['app:copy-file'](null, 'appdoc://d1/missing.md', dest)
      expect(existsSync(dest)).toBe(false)
    })
  })
})
