import { describe, it, expect, beforeEach, vi } from 'vitest'
import { printDocument } from './printDocument'
import { setExportHtml } from './exportStore'
import { sanitizeHtml } from './sanitize'
import { useUIStore } from '../store/ui'
import '../i18n'

const prepareExportHtml = vi.fn(async () => '<h1>baked</h1>')
// Typed to the real `buildStandaloneHtml` signature so the mock wrapper below (and the
// `toHaveBeenCalledWith` assertion) stay honest — a bare `vi.fn()` would accept anything.
const buildStandaloneHtml = vi.fn(
  async (_opts: { theme: 'light' | 'dark'; embedImages: boolean }) => '<html>complete</html>',
)

vi.mock('./exportBake', () => ({
  prepareExportHtml: () => prepareExportHtml(),
}))
vi.mock('./export', () => ({
  buildStandaloneHtml: (opts: { theme: 'light' | 'dark'; embedImages: boolean }) =>
    buildStandaloneHtml(opts),
  resolveTheme: () => 'light',
}))

const print = vi.fn(async () => {})
const alertMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  setExportHtml(sanitizeHtml('<h1>lazy</h1>'))
  useUIStore.getState().setPrinting(false)
  // The export cache holds THIS document's render (C20 add ⑦); the stale-cache case is tested below.
  useUIStore.getState().setExportReady(true)
  ;(window as unknown as { api: unknown }).api = {
    export: { print },
    menu: { setFileLocked: vi.fn() },
  }
  ;(window as unknown as { alert: unknown }).alert = alertMock
})

describe('printDocument — the single print action', () => {
  it('bakes EVERY diagram before printing (ADR 0019) and prints the complete HTML', async () => {
    await printDocument()
    expect(prepareExportHtml).toHaveBeenCalledTimes(1)
    expect(buildStandaloneHtml).toHaveBeenCalledWith({ theme: 'light', embedImages: true })
    expect(print).toHaveBeenCalledWith('<html>complete</html>')
  })

  it('toggles the printing state and mirrors it to the native menu as fileLocked', async () => {
    await printDocument()
    const setFileLocked = (
      window.api as unknown as { menu: { setFileLocked: ReturnType<typeof vi.fn> } }
    ).menu.setFileLocked
    expect(setFileLocked.mock.calls).toEqual([[true], [false]])
    expect(useUIStore.getState().printing).toBe(false)
  })

  it('stands down when no export HTML is ready', async () => {
    setExportHtml(sanitizeHtml(''))
    await printDocument()
    expect(print).not.toHaveBeenCalled()
    expect(alertMock).toHaveBeenCalled()
  })

  // The cache can be non-empty and still belong to the PREVIOUS document (a switch or a parse is
  // in flight). The export dialog refuses in that state, so printing — the other consumer of the
  // same cache — must refuse too, instead of sending another document to the printer.
  it('stands down while the cache still holds the previous document', async () => {
    useUIStore.getState().setExportReady(false)
    await printDocument()
    expect(print).not.toHaveBeenCalled()
    expect(prepareExportHtml).not.toHaveBeenCalled()
    expect(alertMock).toHaveBeenCalled()
  })

  it('refuses a second print while one is in flight', async () => {
    useUIStore.getState().setPrinting(true)
    await printDocument()
    expect(print).not.toHaveBeenCalled()
  })

  // The menu mirror is the second place the printing state lives. The store subscription swallows a
  // failing mirror (a missing/again-failing bridge must not break the store update, nor disable Print
  // for the rest of the session): printing still clears and the print still happens.
  it('clears the printing state even when the menu mirror rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const setFileLocked = vi.fn(() => {
      throw new Error('bridge down')
    })
    ;(window as unknown as { api: unknown }).api = {
      export: { print },
      menu: { setFileLocked },
    }
    await printDocument()
    expect(useUIStore.getState().printing).toBe(false)
    expect(print).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalled()
  })

  it('surfaces a failure and still clears the printing state', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    print.mockRejectedValueOnce(new Error('no printer'))
    await printDocument()
    expect(alertMock).toHaveBeenCalledWith(expect.stringContaining('no printer'))
    expect(useUIStore.getState().printing).toBe(false)
    expect(
      (window.api as unknown as { menu: { setFileLocked: ReturnType<typeof vi.fn> } }).menu
        .setFileLocked.mock.calls,
    ).toEqual([[true], [false]])
  })

  // The alert message is built from `(e as Error)?.message || String(e)`. A non-Error rejection
  // (null) must not crash: this covers the `?.` nullish branch and the `||` right-hand fallback.
  it('falls back to String(e) when the rejection is not an Error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    print.mockRejectedValueOnce(null)
    await printDocument()
    expect(alertMock).toHaveBeenCalledWith(expect.stringContaining('null'))
    expect(useUIStore.getState().printing).toBe(false)
  })

  // An `Error` with an empty message is falsy, so the `|| String(e)` branch must still fire.
  it('falls back to String(e) when an Error carries no message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    print.mockRejectedValueOnce(new Error(''))
    await printDocument()
    expect(alertMock).toHaveBeenCalledWith(expect.stringContaining('Error'))
    expect(useUIStore.getState().printing).toBe(false)
  })
})
