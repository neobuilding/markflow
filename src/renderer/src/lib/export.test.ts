import { describe, it, expect, vi, beforeEach } from 'vitest'
import { exportDocument } from './export'
import { setExportHtml } from './exportStore'

describe('export — buildStandaloneHtml (R7)', () => {
  beforeEach(() => {
    setExportHtml('')
  })

  it('非内联：注入 github-markdown/katex CSS 与 meta charset=utf-8，appdoc:// 改写为相对路径', async () => {
    setExportHtml('<h1>title</h1><img src="appdoc://doc1/a.png">')
    let captured = ''
    ;(window as unknown as { api: unknown }).api = {
      export: {
        embedImages: vi.fn(async (h: string) => h),
        write: vi.fn(async (_p: string, html: string) => {
          captured = html
        }),
      },
    }
    await exportDocument({ path: 'x.html', theme: 'light', embedImages: false })
    expect(captured).toContain('<meta charset="utf-8">')
    expect(captured).toContain('class="markdown-body"')
    expect(captured).toContain('src="a.png"') // appdoc 重写相对路径
  })

  it('暗色主题选择 github-markdown-dark.css', async () => {
    setExportHtml('<p>x</p>')
    let captured = ''
    ;(window as unknown as { api: unknown }).api = {
      export: {
        embedImages: vi.fn(async (h: string) => h),
        write: vi.fn(async (_p: string, html: string) => {
          captured = html
        }),
      },
    }
    await exportDocument({ path: 'x.html', theme: 'dark', embedImages: false })
    expect(captured).toContain('data-color-mode="dark"')
  })

  it('内联图片：调用 embedImages 内联为 base64', async () => {
    setExportHtml('<img src="appdoc://doc1/a.png">')
    const embed = vi.fn(async (h: string) => h.replace('appdoc://doc1/a.png', 'data:image/png;base64,XYZ'))
    ;(window as unknown as { api: unknown }).api = {
      export: { embedImages: embed, write: vi.fn() },
    }
    await exportDocument({ path: 'x.html', theme: 'light', embedImages: true })
    expect(embed).toHaveBeenCalled()
  })
})
