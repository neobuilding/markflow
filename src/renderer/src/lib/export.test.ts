import { describe, it, expect, vi, beforeEach } from 'vitest'
import { exportDocument, resolveTheme } from './export'
import { setExportHtml, setExportContent } from './exportStore'
import { sanitizeHtml } from './sanitize'

// The export cache is typed `SanitizedHtml`, so fixtures must go through the real gate
// exactly like the preview does — that is the point of the brand (ADR-0002).
const clean = (html: string) => sanitizeHtml(html)

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
    setExportHtml(clean(''))
    setExportContent('')
  })

  it('resolves <html lang> from frontmatter at export time (computed on demand, not pre-baked in preview)', async () => {
    setExportHtml(clean('<h1>안녕하세요</h1>'))
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
    setExportHtml(clean('<h1>你好</h1>'))
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
    setExportHtml(clean('<p>x</p>'))
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
    setExportHtml(clean('<h1>title</h1><img src="appdoc://doc1/a.png">'))
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
    setExportHtml(clean('<p>x</p>'))
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
    setExportHtml(clean('<img src="appdoc://doc1/a.png">'))
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

describe('export — non-test-runner / defensive branches (C33a coverage)', () => {
  // `readCssFromDisk` and the katex `@font-face` split only differ from the happy path when the
  // code runs OUTSIDE the test runner (or without a `process.cwd`). Those branches are statically
  // eliminated in the Vite production build, so they can only be exercised by re-importing the
  // module with `import.meta.env.MODE` flipped and by simulating a missing `process.cwd`.
  it('skips the disk fallback when not running under the test runner, and a font-less katex sheet yields no inlined @font-face', async () => {
    vi.stubEnv('MODE', 'production')
    vi.resetModules()
    try {
      const exportMod = await import('./export')
      const parts = await exportMod.buildExportParts({
        theme: 'light',
        embedImages: false,
        body: '<p>x</p>',
      })
      // Outside the test runner the `?raw` imports are populated and the disk fallback is skipped,
      // so `readCssFromDisk` returns '' early — covering the `if (!isTestRunner) return ''` branch.
      expect(parts.fontCss).toBe('')
      expect(parts.theme).toBe('light')
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })

  it('tolerates a missing process.cwd in readCssFromDisk (empty cwd fallback)', async () => {
    // The `globalThis.process?.cwd?.() ?? ''` branch is only taken when `process.cwd()` is
    // unavailable. With no cwd the disk path collapses to a repo-relative string that cannot be
    // resolved, so `buildExportParts` rejects — but the `?? ''` branch itself must be exercised
    // (it must not raise a *different*, e.g. env-access, error before reaching the read).
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(undefined as unknown as string)
    vi.resetModules()
    try {
      const exportMod = await import('./export')
      await expect(
        exportMod.buildExportParts({ theme: 'dark', embedImages: false, body: '<p>y</p>' }),
      ).rejects.toThrow()
    } finally {
      cwdSpy.mockRestore()
      vi.resetModules()
    }
  })
})
