import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers: Record<string, (...a: unknown[]) => unknown> = {}
const h = vi.hoisted(() => ({
  open: { canceled: false, filePaths: ['/a.md'] },
  save: { canceled: false, filePath: '/out.md' as string | undefined },
  confirm: { response: 1 },
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
    showMessageBox: vi.fn(async () => h.confirm),
  },
}))
vi.mock('../lib/md-files', () => ({
  collectMarkdownFiles: (dir: string) => [`${dir}/x.md`],
  MD_EXTS: new Set(['.md']),
}))

import { registerDialogHandlers } from './dialog'

describe('dialog handlers', () => {
  beforeEach(() => {
    for (const k of Object.keys(handlers)) delete handlers[k]
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
