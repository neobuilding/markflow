import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers: Record<string, (...a: unknown[]) => unknown> = {}
const h = vi.hoisted(() => ({
  open: { canceled: false, filePaths: ['/a.md'] },
  save: { canceled: false, filePath: '/out.md' as string | undefined },
  confirm: { response: 1 },
  calls: [] as any[],
  // Record every native-box invocation so tests can assert the buttons/defaultId/cancelId
  // the production code builds from the IPC opts (the contract the e2e spy also checks).
  showMessageBox: vi.fn(async (o: any) => {
    ;(h.calls as any[]).push(o)
    return (h as any).confirm
  }),
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => {
      handlers[ch] = fn
    },
  },
  dialog: {
    showOpenDialog: vi.fn(async () => h.open),
    showSaveDialog: vi.fn(async () => h.save),
    showMessageBox: h.showMessageBox,
  },
}))
vi.mock('../lib/md-files', () => ({
  collectMarkdownFiles: (dir: string) => [`${dir}/x.md`],
  MD_EXTS: new Set(['.md']),
}))
// Identity translator, matching menu.test.ts: the keys themselves are the assertions, so the
// test proves the defaults are read from the dictionary instead of hardcoded English.
vi.mock('../i18n', () => ({
  menuT: (key: string) => key,
}))

import { registerDialogHandlers } from './dialog'

describe('dialog handlers', () => {
  beforeEach(() => {
    for (const k of Object.keys(handlers)) delete handlers[k]
    h.calls.length = 0
    registerDialogHandlers()
  })

  it('open-files returns file paths (or [] when canceled)', async () => {
    h.open = { canceled: false, filePaths: ['/a.md'] }
    expect(await handlers['dialog:open-files'](null)).toEqual(['/a.md'])
    h.open = { canceled: true, filePaths: [] }
    expect(await handlers['dialog:open-files'](null)).toEqual([])
  })

  it('open-folder collects markdown files under the chosen dir', async () => {
    h.open = { canceled: false, filePaths: ['/docs'] }
    const out = (await handlers['dialog:open-folder'](null)) as string[]
    expect(out).toEqual(['/docs/x.md'])
  })

  it('open-folder returns [] when canceled', async () => {
    h.open = { canceled: true, filePaths: [] }
    expect(await handlers['dialog:open-folder'](null)).toEqual([])
  })

  it('select-folder returns the dir or null', async () => {
    h.open = { canceled: false, filePaths: ['/sel'] }
    expect(await handlers['dialog:select-folder'](null)).toBe('/sel')
    h.open = { canceled: true, filePaths: [] }
    expect(await handlers['dialog:select-folder'](null)).toBeNull()
  })

  it('save-file returns the path or null', async () => {
    h.save = { canceled: false, filePath: '/out.md' }
    expect(await handlers['dialog:save-file'](null, '/def.md')).toBe('/out.md')
    h.save = { canceled: true, filePath: undefined }
    expect(await handlers['dialog:save-file'](null)).toBeNull()
  })

  it('confirm returns true when the OK button (response 1) is chosen', async () => {
    h.confirm = { response: 1 }
    expect(await handlers['dialog:confirm'](null, { message: 'Sure?' })).toBe(true)
    h.confirm = { response: 0 }
    expect(await handlers['dialog:confirm'](null, { message: 'Sure?' })).toBe(false)
  })

  it('confirm maps okText/cancelText to a [cancel, ok] buttons array with defaults', async () => {
    h.confirm = { response: 1 }
    h.calls.length = 0
    await handlers['dialog:confirm'](null, {
      message: 'You have unsaved changes. Discard them and close the workspace?',
      detail: 'Some detail',
      okText: 'Discard',
      cancelText: 'Keep editing',
    })
    expect(h.calls[0]).toMatchObject({
      type: 'question',
      message: 'You have unsaved changes. Discard them and close the workspace?',
      detail: 'Some detail',
      // Production contract: buttons = [cancelText, okText], default=ok (1), cancel=Keep (0).
      buttons: ['Keep editing', 'Discard'],
      defaultId: 1,
      cancelId: 0,
    })
  })

  it('confirm falls back to the localized app.cancel / app.ok when no labels are provided', async () => {
    h.calls.length = 0
    await handlers['dialog:confirm'](null, { message: 'Sure?' })
    // Not the hardcoded 'Cancel'/'OK': the fallbacks must come from the shared dictionary so
    // a Chinese UI never shows an English button.
    expect(h.calls[0].buttons).toEqual(['app.cancel', 'app.ok'])
    expect(h.calls[0].defaultId).toBe(1)
    expect(h.calls[0].cancelId).toBe(0)
  })

  it('save-html returns the html path or null', async () => {
    h.save = { canceled: false, filePath: '/out.html' }
    expect(await handlers['dialog:save-html'](null)).toBe('/out.html')
    h.save = { canceled: true, filePath: undefined }
    expect(await handlers['dialog:save-html'](null)).toBeNull()
  })

  it('save-file returns null when filePath is absent even if not canceled', async () => {
    // Exercises the `result.filePath ?? null` branch (filePath undefined, not canceled).
    h.save = { canceled: false, filePath: undefined }
    expect(await handlers['dialog:save-file'](null)).toBeNull()
  })

  it('save-html returns null when filePath is absent even if not canceled', async () => {
    h.save = { canceled: false, filePath: undefined }
    expect(await handlers['dialog:save-html'](null)).toBeNull()
  })
})
