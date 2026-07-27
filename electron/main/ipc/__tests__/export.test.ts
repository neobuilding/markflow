// @vitest-environment node
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { registerExportHandlers } from '../export'
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// better-sqlite3 is a native module compiled against the Electron ABI in the main process,
// so it can't load under the system Node (it would trigger a node-gyp rebuild and hang for a
// long time). The export test uses vi.mock to provide a fake DB, avoiding the
// initDatabase → better-sqlite3 load.
const hoist = vi.hoisted(() => ({ imgDocPath: '' }))
vi.mock('../../db/database', () => ({
  getDb: () => ({
    prepare: () => ({ get: () => ({ file_path: hoist.imgDocPath }) }),
  }),
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
  'hex'
)

beforeAll(() => {
  registerExportHandlers(fakeIpcMain)
})

describe('export — embed-images (R7)', () => {
  it('data: 图片原样保留（不触碰 DB）', async () => {
    const html = '<img src="data:image/png;base64,AAAA">'
    const out = (await handlers['export:embed-images'](null, html)) as string
    expect(out).toContain('data:image/png;base64,AAAA')
  })

  it('appdoc:// 内联为 base64 data URL（经假 DB 取 file_path）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-embed-'))
    const imgPath = join(dir, 'a.png')
    writeFileSync(imgPath, PNG)
    const mdPath = join(dir, 'doc.md')
    writeFileSync(mdPath, '# hi')
    hoist.imgDocPath = mdPath // 假 DB：doc 的 file_path
    const html = `<img src="appdoc://doc1/a.png">`
    const out = (await handlers['export:embed-images'](null, html)) as string
    expect(out).toContain('data:image/png;base64,')
    expect(out).not.toContain('appdoc://')
  })
})

describe('export — write (R7)', () => {
  it('写出 HTML 到磁盘', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-write-'))
    const p = join(dir, 'o.html')
    await handlers['export:write'](null, p, '<p>hi</p>')
    expect(readFileSync(p, 'utf-8')).toBe('<p>hi</p>')
  })
})
