import { describe, it, expect, vi, beforeAll } from 'vitest'
import { registerExportHandlers, mapPrintFailureReason } from '../export'
import { writeFileSync, mkdtempSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// better-sqlite3 is a native module compiled against the Electron ABI in the main process,
// so it can't load under the system Node (it would trigger a node-gyp rebuild and hang for a
// long time). The export test uses vi.mock to provide a fake DB, avoiding the
// initDatabase → better-sqlite3 load.
const hoist = vi.hoisted(() => ({ imgDocPath: '' }))
vi.mock('../../db/database', () => ({
  getDb: () => ({
    prepare: () => ({
      get: () => (hoist.imgDocPath === '__NONE__' ? undefined : { file_path: hoist.imgDocPath }),
    }),
  }),
}))

// The main-process Electron runtime is unavailable under plain Node. Stub the only value import
// (BrowserWindow) so the module loads; the print path that constructs it is excluded from coverage.
vi.mock('electron', () => ({
  BrowserWindow: class {
    loadFile() {
      return Promise.resolve()
    }
    webContents = {
      executeJavaScript: () => Promise.resolve(),
      print: (_o: unknown, cb: (s: boolean) => void) => cb(true),
      getPrintersAsync: () => Promise.resolve([]),
    }
    setBounds() {}
    show() {}
    minimize() {}
    focus() {}
    destroy() {}
  },
}))

const handlers: Record<string, (...args: unknown[]) => unknown> = {}
const fakeIpcMain = {
  handle: (ch: string, fn: (...a: unknown[]) => unknown) => {
    handlers[ch] = fn
  },
} as unknown as import('electron').IpcMain

// 1x1 transparent PNG
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
)

beforeAll(() => {
  registerExportHandlers(fakeIpcMain)
})

describe('export — embed-images (R7)', () => {
  it('data: image preserved as-is (no DB access)', async () => {
    const html = '<img src="data:image/png;base64,AAAA">'
    const out = (await handlers['export:embed-images'](null, html)) as string
    expect(out).toContain('data:image/png;base64,AAAA')
  })

  it('appdoc:// inlined as base64 data URL (file_path fetched via fake DB)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-embed-'))
    const imgPath = join(dir, 'a.png')
    writeFileSync(imgPath, PNG)
    const mdPath = join(dir, 'doc.md')
    writeFileSync(mdPath, '# hi')
    hoist.imgDocPath = mdPath // fake DB: the document's file_path
    const html = `<img src="appdoc://doc1/a.png">`
    const out = (await handlers['export:embed-images'](null, html)) as string
    expect(out).toContain('data:image/png;base64,')
    expect(out).not.toContain('appdoc://')
  })
})

describe('export — write (R7)', () => {
  it('writes HTML to disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-write-'))
    const p = join(dir, 'o.html')
    await handlers['export:write'](null, p, '<p>hi</p>')
    expect(readFileSync(p, 'utf-8')).toBe('<p>hi</p>')
  })

  it('overwrites an existing file when overwrite=true', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-write-'))
    const p = join(dir, 'o.html')
    writeFileSync(p, '<p>old</p>')
    await handlers['export:write'](null, p, '<p>new</p>', true)
    expect(readFileSync(p, 'utf-8')).toBe('<p>new</p>')
  })

  it('refuses to overwrite an existing file when overwrite=false (throws FILE_EXISTS)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-write-'))
    const p = join(dir, 'o.html')
    writeFileSync(p, '<p>old</p>')
    expect(() => handlers['export:write'](null, p, '<p>new</p>', false)).toThrow('FILE_EXISTS')
    // original content is preserved
    expect(readFileSync(p, 'utf-8')).toBe('<p>old</p>')
  })

  it('throws a TypeError when path or html is not a string', () => {
    expect(() => handlers['export:write'](null, 123 as never, '<p>x</p>')).toThrow(TypeError)
    expect(() => handlers['export:write'](null, 'x.html', null as never)).toThrow(TypeError)
  })

  it('propagates a non-EEXIST open error unchanged (e.g. a missing parent directory)', () => {
    // A path whose parent directory does not exist makes openSync throw ENOENT; the catch
    // must re-throw it (not convert to FILE_EXISTS).
    const badPath = join(tmpdir(), 'no-such-dir-xyz', 'o.html')
    expect(() => handlers['export:write'](null, badPath, '<p>hi</p>')).toThrow()
  })
})

describe('export — print (R7)', () => {
  it('throws a TypeError when html is not a string', async () => {
    await expect(handlers['export:print'](null, 123 as never)).rejects.toThrow(TypeError)
  })

  it('rejects every non-string payload shape with a descriptive TypeError', async () => {
    for (const bad of [undefined, null, 0, {}, [], true] as never[]) {
      await expect(handlers['export:print'](null, bad)).rejects.toThrow(
        'export:print expects string html',
      )
    }
  })

  it('accepts a string payload and resolves via the print pipeline', async () => {
    // The guard must let strings through; the mocked BrowserWindow reports a successful
    // print, so the handler resolves with undefined instead of throwing.
    await expect(handlers['export:print'](null, '<h1>hi</h1>')).resolves.toBeUndefined()
  })

  it('accepts an empty string (a valid, if trivial, payload)', async () => {
    await expect(handlers['export:print'](null, '')).resolves.toBeUndefined()
  })
})

describe('export — mapPrintFailureReason (pure)', () => {
  it('returns a generic message when no reason is given', () => {
    expect(mapPrintFailureReason()).toBe('Print failed')
  })

  it('maps an "invalid printer settings" reason to the actionable message', () => {
    expect(mapPrintFailureReason('Invalid printer settings')).toContain('Microsoft Print to PDF')
  })

  it('passes through any other reason unchanged', () => {
    expect(mapPrintFailureReason('driver crashed')).toBe('driver crashed')
  })
})

describe('export — embed-images edge cases (R7)', () => {
  it('keeps the original <img> when the appdoc url cannot be parsed (null doc)', async () => {
    const html = `<img src="appdoc://doc-without-path">`
    const out = (await handlers['export:embed-images'](null, html)) as string
    expect(out).toContain('appdoc://doc-without-path')
    expect(out).not.toContain('data:image')
  })

  it('keeps the original <img> when the appdoc doc id has no DB row', async () => {
    hoist.imgDocPath = '__NONE__' // fake DB returns undefined for this doc id
    const html = `<img src="appdoc://ghost/a.png">`
    const out = (await handlers['export:embed-images'](null, html)) as string
    expect(out).toContain('appdoc://ghost/a.png')
  })

  it('keeps the original <img> when the resolved image file cannot be read', async () => {
    // the DB row exists but points at a path that does not exist on disk -> readFileSync throws
    hoist.imgDocPath = join(tmpdir(), 'does-not-exist-xyz', 'doc.md')
    const html = `<img src="appdoc://doc1/a.png">`
    const out = (await handlers['export:embed-images'](null, html)) as string
    expect(out).toContain('appdoc://doc1/a.png')
    expect(out).not.toContain('data:image')
  })

  it('keeps the original <img> when the resolved image path escapes the document directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-embed-'))
    const mdPath = join(dir, 'doc.md')
    writeFileSync(mdPath, '# hi')
    // Create a real image file OUTSIDE the doc's directory (a different temp dir).
    const siblingDir = mkdtempSync(join(tmpdir(), 'mf-embed-sibling-'))
    writeFileSync(join(siblingDir, 'escape.png'), PNG)
    hoist.imgDocPath = mdPath
    // The appdoc URL encodes an ABSOLUTE path to that outside file as the relPath.
    // (A `../` form would be stripped by new URL() path normalization; using an absolute
    // path makes the escape survive parsing so isSubdir() can evaluate and return false.)
    const url = `appdoc://doc1/${encodeURIComponent(siblingDir)}%2Fescape.png`
    const html = `<img src="${url}">`
    const out = (await handlers['export:embed-images'](null, html)) as string
    expect(out).toContain('appdoc://')
    expect(out).not.toContain('data:image')
  })

  it('keeps the original <img> for an unsupported (relative) src that cannot be inlined', async () => {
    const html = `<img src="relative.png">`
    const out = (await handlers['export:embed-images'](null, html)) as string
    expect(out).toContain('relative.png')
    expect(out).not.toContain('data:image')
  })

  it('keeps the original <img> when the resolved image path is a directory (readFileSync throws)', async () => {
    // A subdirectory inside the doc's directory passes the isSubdir containment check, but
    // readFileSync on a directory throws — the TOCTOU guard returns null and keeps the original <img>.
    const dir = mkdtempSync(join(tmpdir(), 'mf-embed-'))
    const mdPath = join(dir, 'doc.md')
    writeFileSync(mdPath, '# hi')
    const subDir = join(dir, 'sub')
    mkdirSync(subDir)
    hoist.imgDocPath = mdPath
    const html = `<img src="appdoc://doc1/sub">`
    const out = (await handlers['export:embed-images'](null, html)) as string
    expect(out).toContain('appdoc://')
    expect(out).not.toContain('data:image')
  })

  it('keeps the original <img> for https images that return a non-ok response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, headers: { get: () => null } })
    const prev = globalThis.fetch
    globalThis.fetch = fetchMock as unknown as typeof fetch
    try {
      const html = `<img src="https://e.com/a.png">`
      const out = (await handlers['export:embed-images'](null, html)) as string
      expect(out).toContain('https://e.com/a.png')
      expect(fetchMock).toHaveBeenCalledWith('https://e.com/a.png')
    } finally {
      globalThis.fetch = prev
    }
  })

  it('inlines https images into a base64 data URL on a successful fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(Buffer.from('fake-bytes').buffer),
      headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'image/png' : null) },
    })
    const prev = globalThis.fetch
    globalThis.fetch = fetchMock as unknown as typeof fetch
    try {
      const html = `<img src="https://e.com/a.png">`
      const out = (await handlers['export:embed-images'](null, html)) as string
      expect(out).toContain('data:image/png;base64,')
      expect(out).not.toContain('https://e.com/a.png')
      expect(fetchMock).toHaveBeenCalledWith('https://e.com/a.png')
    } finally {
      globalThis.fetch = prev
    }
  })

  it('falls back to image/png when a successful https fetch omits the content-type header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(Buffer.from('fake-bytes').buffer),
      headers: { get: () => null },
    })
    const prev = globalThis.fetch
    globalThis.fetch = fetchMock as unknown as typeof fetch
    try {
      const html = `<img src="https://e.com/a.png">`
      const out = (await handlers['export:embed-images'](null, html)) as string
      // content-type ?? 'image/png' fallback fires -> the data URL mime is image/png
      expect(out).toContain('data:image/png;base64,')
      expect(out).not.toContain('https://e.com/a.png')
    } finally {
      globalThis.fetch = prev
    }
  })

  it('inlines an appdoc image with an unknown extension using the octet-stream fallback mime', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-embed-'))
    const mdPath = join(dir, 'doc.md')
    writeFileSync(mdPath, '# hi')
    // a file whose extension is not in APPDOC_MIME -> `?? 'application/octet-stream'`
    const imgPath = join(dir, 'a.unknownext')
    writeFileSync(imgPath, PNG)
    hoist.imgDocPath = mdPath
    const html = `<img src="appdoc://doc1/a.unknownext">`
    const out = (await handlers['export:embed-images'](null, html)) as string
    expect(out).toContain('data:application/octet-stream;base64,')
    expect(out).not.toContain('appdoc://')
  })
})
