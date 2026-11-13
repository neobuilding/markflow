import { describe, it, expect, vi, beforeAll } from 'vitest'
import {
  registerExportHandlers,
  mapPrintFailureReason,
  resolvePrintWindowBounds,
  printDisplayWorkArea,
} from './export'
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkTestDir } from '../test-support/tmp'

// The export handler now reads document file paths from the in-memory store singleton.
// Mock that module's getDocumentById so the test controls which file_path a doc id resolves to.
const hoist = vi.hoisted(() => ({
  imgDocPath: '',
  // Records calls on EVERY print-related BrowserWindow, tagged with an instance id so a test can
  // tell the system-dialog OWNER apart from the user-visible PREVIEW window (R5).
  printCalls: [] as Array<{ m: string; a?: unknown; id?: number }>,
  // Calls on the MarkFlow MAIN window. Plan A must NEVER whole-window disable it (that would
  // freeze the preview pane), so this array is asserted to contain no setEnabled(false).
  mainCalls: [] as Array<{ m: string; a?: unknown }>,
}))
vi.mock('../model/documentStore', () => ({
  getDocumentById: (id: string) => {
    if (id === '__NONE__' || hoist.imgDocPath === '__NONE__') return null
    return { id, filePath: hoist.imgDocPath } as unknown
  },
}))

// Make the print pipeline anchor to a live (fake) main window so the placement logic resolves
// through getMainWindow() to a SECONDARY monitor work area instead of falling back to primary.
vi.mock('../state', () => ({
  getMainWindow: () => ({
    isDestroyed: () => false,
    getBounds: () => ({ x: 2000, y: 100 }),
    setEnabled: (enabled: boolean) => hoist.mainCalls.push({ m: 'setEnabled', a: enabled }),
  }),
}))

// The main-process Electron runtime is unavailable under plain Node. Stub the only value import
// (BrowserWindow) so the module loads; the print path that constructs it is excluded from coverage.
vi.mock('electron', () => {
  let nextId = 1
  return {
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      getDisplayMatching: () => ({ workArea: { x: 1920, y: 0, width: 1600, height: 900 } }),
    },
    BrowserWindow: Object.assign(
      class {
        id = nextId++
        // Constructor options are recorded too, so tests can assert the window is created with the
        // shell-UI presence (taskbar) a recoverable print dialog needs (R5).
        constructor(opts: unknown) {
          hoist.printCalls.push({ m: 'ctor', a: opts, id: this.id })
        }
        loadFile() {
          return Promise.resolve()
        }
        webContents = {
          executeJavaScript: () => Promise.resolve(),
          print: (_o: unknown, cb: (s: boolean) => void) => {
            hoist.printCalls.push({ m: 'print', id: this.id })
            cb(true)
          },
          getPrintersAsync: () => Promise.resolve([]),
        }
        setBounds(...args: unknown[]) {
          hoist.printCalls.push({ m: 'setBounds', a: args[0], id: this.id })
        }
        show() {
          hoist.printCalls.push({ m: 'show', id: this.id })
        }
        minimize() {
          hoist.printCalls.push({ m: 'minimize', id: this.id })
        }
        // Transparency is legitimate ONLY on the hidden system-dialog owner, never on the
        // user-visible PREVIEW window. The id tag is what lets the R5 test enforce that.
        setOpacity(v: number) {
          hoist.printCalls.push({ m: 'setOpacity', a: v, id: this.id })
        }
        setIgnoreMouseEvents(v: boolean) {
          hoist.printCalls.push({ m: 'setIgnoreMouseEvents', a: v, id: this.id })
        }
        setEnabled(v: boolean) {
          hoist.printCalls.push({ m: 'setEnabled', a: v, id: this.id })
        }
        focus() {
          hoist.printCalls.push({ m: 'focus', id: this.id })
        }
        destroy() {
          hoist.printCalls.push({ m: 'destroy', id: this.id })
        }
      },
      {
        // Static helpers the print window uses to degrade from `getMainWindow()` to any other
        // MarkFlow window before falling back to the primary display. No windows exist in a Node
        // test, so both report empty and the placement falls back to the primary work area.
        getFocusedWindow: () => null,
        getAllWindows: () => [] as unknown[],
      },
    ),
  }
})

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
  it('data: image preserved as-is (no store access)', async () => {
    const html = '<img src="data:image/png;base64,AAAA">'
    const out = (await handlers['export:embed-images'](null, html)) as string
    expect(out).toContain('data:image/png;base64,AAAA')
  })

  it('appdoc:// inlined as base64 data URL (file_path fetched via store mock)', async () => {
    const dir = mkTestDir('mf-embed-')
    const imgPath = join(dir, 'a.png')
    writeFileSync(imgPath, PNG)
    const mdPath = join(dir, 'doc.md')
    writeFileSync(mdPath, '# hi')
    hoist.imgDocPath = mdPath // store mock: the document's file_path
    const html = `<img src="appdoc://doc1/a.png">`
    const out = (await handlers['export:embed-images'](null, html)) as string
    expect(out).toContain('data:image/png;base64,')
    expect(out).not.toContain('appdoc://')
  })
})

describe('export — write (R7)', () => {
  it('writes HTML to disk', async () => {
    const dir = mkTestDir('mf-write-')
    const p = join(dir, 'o.html')
    await handlers['export:write'](null, p, '<p>hi</p>')
    expect(readFileSync(p, 'utf-8')).toBe('<p>hi</p>')
  })

  it('overwrites an existing file when overwrite=true', async () => {
    const dir = mkTestDir('mf-write-')
    const p = join(dir, 'o.html')
    writeFileSync(p, '<p>old</p>')
    await handlers['export:write'](null, p, '<p>new</p>', true)
    expect(readFileSync(p, 'utf-8')).toBe('<p>new</p>')
  })

  it('refuses to overwrite an existing file when overwrite=false (throws FILE_EXISTS)', () => {
    const dir = mkTestDir('mf-write-')
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

describe('export — print owner window state (R5/R6)', () => {
  it('keeps the hidden dialog owner un-minimized and anchored on the MarkFlow monitor (no OS dialog)', async () => {
    // Drives the REAL openPrintDialog path end to end with a mocked BrowserWindow. No native
    // print dialog is opened (the mock's webContents.print resolves the callback immediately), so
    // this is a fast, deterministic regression that locks the owner window state the system print
    // dialog derives its placement and focus from — without blocking on a real OS dialog.
    hoist.printCalls.length = 0
    await handlers['export:print'](null, '<h1>x</h1>')

    const calls = hoist.printCalls
    const call = (m: string, a?: unknown) =>
      calls.some((c) => c.m === m && (a === undefined || c.a === a))

    // R6: a minimized owner is parked at (-32000,-32000) by Windows, so the dialog centers onto
    // the leftmost/primary monitor regardless of where MarkFlow is. The fix must never minimize.
    expect(
      call('minimize'),
      'a minimized owner drops the dialog onto the leftmost monitor (R6)',
    ).toBe(false)
    // The HIDDEN owner (the window whose webContents calls print) must be shown but invisible and
    // un-hittable: an unseen implementation detail. Plan A has no second window at all, and the
    // MAIN window stays enabled so its preview pane can still be scrolled.
    expect(call('show')).toBe(true)
    expect(call('setOpacity', 0), 'hidden dialog owner must not be seen by the user (R5)').toBe(
      true,
    )
    expect(call('setIgnoreMouseEvents', true), 'hidden owner must not intercept clicks (R5)').toBe(
      true,
    )

    // R5 recoverability (user report 2026-11-12): the print dialog is an OWNED window — it gets no
    // taskbar entry of its own, and MarkFlow's main window is not its modal owner, so clicking
    // MarkFlow sinks it. A skipTaskbar owner leaves nothing to recover it with (no taskbar, no
    // Alt+Tab), so the owner must keep its taskbar button; and focus() is what foregrounds the
    // dialog in the first place so it does not open behind other windows.
    const ctor = calls.find((c) => c.m === 'ctor')
    expect(ctor).toBeDefined()
    expect(
      (ctor!.a as { skipTaskbar?: boolean }).skipTaskbar,
      'owner must keep a taskbar button so a backgrounded print dialog can be recovered (R5)',
    ).toBeUndefined()
    expect(call('focus'), 'owner focus is what foregrounds the print dialog (R5)').toBe(true)

    // R6 data path: the owner is centred on the SECONDARY monitor (x in [1920, 3520)), not pinned to
    // the primary origin — so the native print dialog centres over the app on the monitor MarkFlow lives on.
    const bounds = calls.find((c) => c.m === 'setBounds')?.a as { x: number } | undefined
    expect(bounds?.x).toBeGreaterThanOrEqual(1920)
    expect(bounds?.x).toBeLessThan(1920 + 1600)
  })
})

// R5 plan A (user decision 2026-11-12): NO standalone print PREVIEW window. The user watches the
// main window's own preview pane instead — the mainstream pattern (Windows UX Guide recommends
// print preview "directly within the main program window"; Chrome / Word / macOS all integrate it).
// Only TWO windows remain: the main window, and the hidden OWNER whose webContents opens the OS
// print dialog.
//
// The main window must NOT be whole-window disabled with setEnabled(false): that would also kill
// scrolling in its preview pane. The "no editing / no switching or closing files" rule is enforced
// in the renderer as a fine-grained print-mode lock, covered by the renderer unit/e2e tests. This
// suite asserts the MAIN-PROCESS half of the contract.
describe('export — R5 plan A: two windows, no standalone preview', () => {
  it('opens exactly one hidden dialog owner and leaves the MAIN window interactive', async () => {
    hoist.printCalls.length = 0
    hoist.mainCalls.length = 0
    await handlers['export:print'](null, '<h1>x</h1>')

    const calls = hoist.printCalls
    const ctorIds = new Set(calls.filter((c) => c.m === 'ctor').map((c) => c.id))
    expect(ctorIds.size, 'no standalone print preview window must be created').toBe(1)
    const shownIds = new Set(calls.filter((c) => c.m === 'show').map((c) => c.id))
    expect(shownIds.size, 'only the hidden owner is shown').toBe(1)
    expect(shownIds.has([...ctorIds][0]!), 'the shown window IS the dialog owner').toBe(true)

    // The owner is an implementation detail: invisible and un-hittable, but a real on-screen
    // window so the OS print dialog keeps its foreground and lands on MarkFlow's monitor (R6).
    expect(calls.some((c) => c.m === 'setOpacity' && c.a === 0)).toBe(true)
    expect(calls.some((c) => c.m === 'setIgnoreMouseEvents' && c.a === true)).toBe(true)
    expect(
      calls.some((c) => c.m === 'print'),
      'the system print dialog is still opened',
    ).toBe(true)

    // Whole-window disabling would freeze the preview pane the user is supposed to look at.
    expect(
      hoist.mainCalls.some((c) => c.m === 'setEnabled' && c.a === false),
      'setEnabled(false) would freeze the main window preview pane (R5 plan A)',
    ).toBe(false)
  })
})

describe('export — print window placement (pure)', () => {
  it('anchors the print window to the SECONDARY monitor instead of (0,0) on the primary', () => {
    const bounds = resolvePrintWindowBounds({ x: 1920, y: 120, width: 1600, height: 900 })
    expect(bounds).toEqual({ x: 2320, y: 270, width: 800, height: 600 })
    expect(bounds.x).not.toBe(0)
  })

  it('clamps the window to a smaller display work area', () => {
    expect(resolvePrintWindowBounds({ x: -800, y: 0, width: 640, height: 400 })).toEqual({
      x: -800,
      y: 0,
      width: 640,
      height: 400,
    })
  })

  it('falls back to the primary display when the main window is gone', () => {
    expect(printDisplayWorkArea(null)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
  })

  it('uses the display matching a live main window', () => {
    const main = { isDestroyed: () => false, getBounds: () => ({ x: 2000, y: 100 }) }
    expect(printDisplayWorkArea(main as never)).toEqual({
      x: 1920,
      y: 0,
      width: 1600,
      height: 900,
    })
  })

  it('falls back to the primary display when the main window is destroyed', () => {
    const main = { isDestroyed: () => true }
    expect(printDisplayWorkArea(main as never)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
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

  it('keeps the original <img> when the appdoc doc id has no store row', async () => {
    hoist.imgDocPath = '__NONE__' // store mock returns undefined for this doc id
    const html = `<img src="appdoc://ghost/a.png">`
    const out = (await handlers['export:embed-images'](null, html)) as string
    expect(out).toContain('appdoc://ghost/a.png')
  })

  it('keeps the original <img> when the resolved image file cannot be read', async () => {
    // the store entry exists but points at a path that does not exist on disk -> readFileSync throws
    hoist.imgDocPath = join(tmpdir(), 'does-not-exist-xyz', 'doc.md')
    const html = `<img src="appdoc://doc1/a.png">`
    const out = (await handlers['export:embed-images'](null, html)) as string
    expect(out).toContain('appdoc://doc1/a.png')
    expect(out).not.toContain('data:image')
  })

  it('keeps the original <img> when the resolved image path escapes the document directory', async () => {
    const dir = mkTestDir('mf-embed-')
    const mdPath = join(dir, 'doc.md')
    writeFileSync(mdPath, '# hi')
    // Create a real image file OUTSIDE the doc's directory (a different temp dir).
    const siblingDir = mkTestDir('mf-embed-sibling-')
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
    // readFileSync on a directory throws the TOCTOU guard returns null and keeps the original <img>
    const dir = mkTestDir('mf-embed-')
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
    const dir = mkTestDir('mf-embed-')
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
