import { describe, it, expect, vi, beforeEach } from 'vitest'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveAppdocPath } from '../ipc/appdoc'
import { mkTestDir } from '../test-support/tmp'

const handlers: Record<string, (...a: unknown[]) => unknown> = {}
const clipboardMock = vi.hoisted(() => ({ writeText: vi.fn(), write: vi.fn() }))
const shellMock = vi.hoisted(() => ({ showItemInFolder: vi.fn(), openExternal: vi.fn() }))
const h = vi.hoisted(() => ({ version: '9.9.9' }))
const nativeImageMock = vi.hoisted(() => ({
  createFromBuffer: (buf: Buffer) => ({
    isEmpty: () => buf.length === 0,
    toPNG: () => buf,
  }),
}))
// jsdom doesn't implement the web `ClipboardItem` global; the handler (which runs in
// the Electron main process) relies on it, so provide a minimal stand-in for tests.
if (typeof (globalThis as { ClipboardItem?: unknown }).ClipboardItem === 'undefined') {
  ;(globalThis as { ClipboardItem?: unknown }).ClipboardItem = class {
    constructor(public readonly items: Record<string, unknown>) {}
  }
}
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

  it('writes the provided text to the clipboard', async () => {
    clipboardMock.writeText.mockClear()
    await (handlers['clipboard:write-text'](null, '/some/long/path.md') as Promise<void>)
    expect(clipboardMock.writeText).toHaveBeenCalledTimes(1)
    expect(clipboardMock.writeText).toHaveBeenCalledWith('/some/long/path.md')
  })

  // Electron 44 made `writeText` async, so a rejected promise — not a synchronous
  // throw — is the realistic failure mode. Cover both and assert the handler still
  // resolves (a sync `expect(...).not.toThrow()` would pass even with no try/catch,
  // because an async handler converts a throw into a rejection).
  it('swallows a synchronous throw from clipboard.writeText', async () => {
    clipboardMock.writeText.mockImplementationOnce(() => {
      throw new Error('clipboard unavailable')
    })
    await expect(
      handlers['clipboard:write-text'](null, 'x') as Promise<void>,
    ).resolves.toBeUndefined()
  })

  it('swallows a rejected clipboard.writeText (no unhandled rejection)', async () => {
    clipboardMock.writeText.mockRejectedValueOnce(new Error('clipboard unavailable'))
    await expect(
      handlers['clipboard:write-text'](null, 'x') as Promise<void>,
    ).resolves.toBeUndefined()
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
    const dir = mkTestDir('mf-img-')
    it('reads the image and writes it to the clipboard', async () => {
      const p = join(dir, 'pic.png')
      writeFileSync(p, Buffer.from([1, 2, 3, 4]))
      clipboardMock.write.mockClear()
      await (handlers['clipboard:write-image'](null, p) as Promise<void>)
      expect(clipboardMock.write).toHaveBeenCalledTimes(1)
      // Electron 44 contract: `write` takes an ARRAY of ClipboardItem whose `image/png`
      // entry carries the PNG bytes. Asserting only the call count would still pass for
      // `write(blob)` or `write([{}])`, so pin the payload shape here.
      const [written] = clipboardMock.write.mock.calls[0] as [
        Array<{ items: Record<string, unknown> }>,
      ]
      expect(Array.isArray(written)).toBe(true)
      expect(written).toHaveLength(1)
      const GlobalClipboardItem = (
        globalThis as unknown as {
          ClipboardItem: new (...a: unknown[]) => unknown
        }
      ).ClipboardItem
      expect(written[0]).toBeInstanceOf(GlobalClipboardItem)
      const blob = written[0].items['image/png'] as Blob
      expect(blob).toBeInstanceOf(Blob)
      expect(blob.type).toBe('image/png')
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
    })
    it('does nothing when the image is empty', async () => {
      const p = join(dir, 'empty.png')
      writeFileSync(p, Buffer.alloc(0))
      clipboardMock.write.mockClear()
      await (handlers['clipboard:write-image'](null, p) as Promise<void>)
      expect(clipboardMock.write).not.toHaveBeenCalled()
    })
    it('does nothing when nativeImage reports an empty image for non-empty bytes', async () => {
      const p = join(dir, 'not-an-image.png')
      writeFileSync(p, Buffer.from([1, 2, 3, 4]))
      // Reachable in production when the bytes aren't a decodable image: the file is
      // non-empty (so it passes the length guard) yet createFromBuffer yields an empty image.
      // The shared mock keys emptiness off buf.length, so override it for this one call.
      vi.spyOn(nativeImageMock, 'createFromBuffer').mockReturnValueOnce({
        isEmpty: () => true,
        toPNG: () => Buffer.alloc(0),
      })
      clipboardMock.write.mockClear()
      await (handlers['clipboard:write-image'](null, p) as Promise<void>)
      expect(clipboardMock.write).not.toHaveBeenCalled()
    })
    it('does not throw on a missing file', async () => {
      clipboardMock.write.mockClear()
      await expect(
        handlers['clipboard:write-image'](null, join(dir, 'gone.png')) as Promise<void>,
      ).resolves.toBeUndefined()
      expect(clipboardMock.write).not.toHaveBeenCalled()
    })
    it('resolves an appdoc:// source before writing', async () => {
      const p = join(dir, 'pic.png')
      writeFileSync(p, Buffer.from([1, 2, 3, 4]))
      vi.mocked(resolveAppdocPath).mockReturnValue(p)
      clipboardMock.write.mockClear()
      await (handlers['clipboard:write-image'](null, 'appdoc://d1/pic.png') as Promise<void>)
      expect(resolveAppdocPath).toHaveBeenCalledWith('appdoc://d1/pic.png')
      expect(clipboardMock.write).toHaveBeenCalledTimes(1)
      vi.mocked(resolveAppdocPath).mockReturnValue(null)
    })
    it('does nothing when an appdoc:// source resolves to nothing', async () => {
      vi.mocked(resolveAppdocPath).mockReturnValue(null)
      clipboardMock.write.mockClear()
      await (handlers['clipboard:write-image'](null, 'appdoc://d1/missing.png') as Promise<void>)
      expect(clipboardMock.write).not.toHaveBeenCalled()
    })
    // Electron 44: `clipboard.write` is async, so a rejection is the realistic failure
    // mode; it must be swallowed instead of surfacing as an unhandled rejection.
    it('swallows a rejected clipboard.write (no unhandled rejection)', async () => {
      const p = join(dir, 'pic.png')
      writeFileSync(p, Buffer.from([1, 2, 3, 4]))
      clipboardMock.write.mockClear()
      clipboardMock.write.mockRejectedValueOnce(new Error('clipboard unavailable'))
      await expect(
        handlers['clipboard:write-image'](null, p) as Promise<void>,
      ).resolves.toBeUndefined()
    })
  })

  describe('clipboard:write-svg (Plan 02 §4.4 / D4)', () => {
    it('writes an image/svg+xml blob plus a text/html wrapper', async () => {
      clipboardMock.write.mockClear()
      await (handlers['clipboard:write-svg'](null, '<svg>x</svg>') as Promise<void>)
      expect(clipboardMock.write).toHaveBeenCalledTimes(1)
      const [written] = clipboardMock.write.mock.calls[0] as [
        Array<{ items: Record<string, Blob> }>,
      ]
      expect(Array.isArray(written)).toBe(true)
      expect(written).toHaveLength(1)
      const GlobalClipboardItem = (
        globalThis as unknown as { ClipboardItem: new (...a: unknown[]) => unknown }
      ).ClipboardItem
      expect(written[0]).toBeInstanceOf(GlobalClipboardItem)
      const svgBlob = written[0].items['image/svg+xml'] as Blob
      const htmlBlob = written[0].items['text/html'] as Blob
      expect(svgBlob).toBeInstanceOf(Blob)
      expect(svgBlob.type).toBe('image/svg+xml')
      expect(htmlBlob).toBeInstanceOf(Blob)
      expect(htmlBlob.type).toBe('text/html')
      expect(await svgBlob.text()).toBe('<svg>x</svg>')
      expect(await htmlBlob.text()).toContain('data:image/svg+xml;base64,')
    })
    it('swallows a rejected clipboard.write (no unhandled rejection)', async () => {
      clipboardMock.write.mockClear()
      clipboardMock.write.mockRejectedValueOnce(new Error('clipboard unavailable'))
      await expect(
        handlers['clipboard:write-svg'](null, '<svg>x</svg>') as Promise<void>,
      ).resolves.toBeUndefined()
    })
  })

  describe('clipboard:write-image — data: URL source (Plan 02 §4.4)', () => {
    it('decodes a data: URL and writes it to the clipboard', async () => {
      const buf = Buffer.from([9, 8, 7, 6])
      const dataUrl = `data:image/png;base64,${buf.toString('base64')}`
      clipboardMock.write.mockClear()
      await (handlers['clipboard:write-image'](null, dataUrl) as Promise<void>)
      expect(clipboardMock.write).toHaveBeenCalledTimes(1)
      const [written] = clipboardMock.write.mock.calls[0] as [
        Array<{ items: Record<string, Blob> }>,
      ]
      const pngBlob = written[0].items['image/png'] as Blob
      expect(new Uint8Array(await pngBlob.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7, 6]))
    })
    it('does nothing for an undecodable data: URL', async () => {
      clipboardMock.write.mockClear()
      // No comma → no body to decode → treated as undecodable, so nothing is written.
      await (handlers['clipboard:write-image'](null, 'data:image/png') as Promise<void>)
      expect(clipboardMock.write).not.toHaveBeenCalled()
    })
    it('decodes a non-base64 (percent-escaped) data: URL and writes it', async () => {
      const dataUrl = 'data:text/plain,hello%20world'
      clipboardMock.write.mockClear()
      await (handlers['clipboard:write-image'](null, dataUrl) as Promise<void>)
      expect(clipboardMock.write).toHaveBeenCalledTimes(1)
      const [written] = clipboardMock.write.mock.calls[0] as [
        Array<{ items: Record<string, Blob> }>,
      ]
      const pngBlob = written[0].items['image/png'] as Blob
      expect(new Uint8Array(await pngBlob.arrayBuffer())).toEqual(
        new Uint8Array(Buffer.from('hello world', 'utf-8')),
      )
    })
    it('does nothing for a malformed percent-escaped data: URL', async () => {
      clipboardMock.write.mockClear()
      // A lone "%" is invalid percent-encoding → decodeURIComponent throws → undecodable.
      await (handlers['clipboard:write-image'](null, 'data:text/plain,%E0%A4%A') as Promise<void>)
      expect(clipboardMock.write).not.toHaveBeenCalled()
    })
  })

  describe('app:copy-file (能力 2 另存为)', () => {
    const dir = mkTestDir('mf-cp-')
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
