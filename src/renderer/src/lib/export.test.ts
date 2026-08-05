import { describe, it, expect, vi, beforeEach } from 'vitest'
import { exportDocument, resolveTheme } from './export'
import { setExportHtml, setExportContent } from './exportStore'

describe('resolveTheme', () => {
  it('returns explicit light/dark choices regardless of uiTheme', () => {
    expect(resolveTheme('light', 'dark')).toBe('light')
    expect(resolveTheme('dark', 'light')).toBe('dark')
  })

  it('follows the ui theme for "current"', () => {
    expect(resolveTheme('current', 'dark')).toBe('dark')
    expect(resolveTheme('current', 'light')).toBe('light')
  })

  it('resolves "system" uiTheme via matchMedia when choice is current', () => {
    const original = window.matchMedia
    window.matchMedia = (() => ({ matches: true })) as unknown as typeof window.matchMedia
    expect(resolveTheme('current', 'system')).toBe('dark')
    window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia
    expect(resolveTheme('current', 'system')).toBe('light')
    window.matchMedia = original
  })
})

describe('export — buildStandaloneHtml (R7)', () => {
  beforeEach(() => {
    setExportHtml('')
    setExportContent('')
  })

  it('resolves <html lang> from frontmatter at export time (computed on demand, not pre-baked in preview)', async () => {
    setExportHtml('<h1>안녕하세요</h1>')
    setExportContent('---\nlang: ko\n---\n\n# 안녕하세요')
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
    expect(captured).toContain('<html lang="ko"')
  })

  it('detects CJK content at export time when no frontmatter lang is given', async () => {
    setExportHtml('<h1>你好</h1>')
    setExportContent('# 你好世界\n\n这是中文内容。')
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
    expect(captured).toContain('<html lang="zh-CN"')
  })

  it('falls back to lang="en" when content is empty', async () => {
    setExportHtml('<p>x</p>')
    setExportContent('')
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
    expect(captured).toContain('<html lang="en"')
  })

  it('non-inline: injects github-markdown/katex CSS and meta charset=utf-8, rewrites appdoc:// to a relative path', async () => {
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
    expect(captured).toContain(
      'body{padding:24px;width:100%;max-width:none;margin:0;box-sizing:border-box;}',
    )
    expect(captured).not.toContain('max-width:980px')
    expect(captured).toContain('src="a.png"') // appdoc rewritten to relative path
  })

  it('dark theme selects github-markdown-dark.css', async () => {
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

  it('inline images: calls embedImages to inline as base64', async () => {
    setExportHtml('<img src="appdoc://doc1/a.png">')
    const embed = vi.fn(async (h: string) =>
      h.replace('appdoc://doc1/a.png', 'data:image/png;base64,XYZ'),
    )
    ;(window as unknown as { api: unknown }).api = {
      export: { embedImages: embed, write: vi.fn() },
    }
    await exportDocument({ path: 'x.html', theme: 'light', embedImages: true })
    expect(embed).toHaveBeenCalled()
  })
})
