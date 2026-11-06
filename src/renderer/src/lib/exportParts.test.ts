import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildExportParts, buildStandaloneHtml } from './export'
import { setExportContent, setExportHtml } from './exportStore'
import { sanitizeHtml } from './sanitize'

// C20 ⑨ — `buildExportParts()` is the single source of truth for BOTH consumers: the standalone
// file and the export preview (a shadow root). These tests pin the split that makes the preview
// possible: the @font-face rules must be separable from the document CSS, because a shadow root
// does not register fonts (S1) and `body` does not match inside one (S2).

const clean = (html: string) => sanitizeHtml(html)

beforeEach(() => {
  setExportHtml(clean('<h1>hi</h1>'))
  setExportContent('# hi')
  ;(window as unknown as { api: unknown }).api = {
    export: {
      embedImages: vi.fn(async (h: string) => h),
      write: vi.fn(async () => {}),
    },
  }
})

describe("C20 ⑨ — buildExportParts (the export preview's single source)", () => {
  it('splits the KaTeX @font-face rules out of the document CSS (S1)', async () => {
    const parts = await buildExportParts({ theme: 'light', embedImages: false })
    // The faces travel separately...
    expect(parts.fontCss).toContain('@font-face')
    expect(parts.fontCss).toContain('KaTeX_Main')
    // ...and the document CSS keeps the layout rules but NOT the faces (a shadow root would
    // silently ignore them there).
    expect(parts.css).not.toContain('@font-face')
    expect(parts.css).toContain('.katex')
  })

  it('returns the container and the document-level custom properties (S2)', async () => {
    const parts = await buildExportParts({ theme: 'light', embedImages: false })
    // `body` does not match inside a shadow root, so the container declarations come back as
    // plain declarations for the preview container to apply.
    expect(parts.containerCss).toBe(
      'padding:24px;width:100%;max-width:none;margin:0;box-sizing:border-box;',
    )
    expect(parts.rootVars).toContain('--md-pre-bg:')
    expect(parts.rootVars).toContain('--md-pre-border:')
  })

  it('switches the code-block tokens with the theme', async () => {
    const light = await buildExportParts({ theme: 'light', embedImages: false })
    const dark = await buildExportParts({ theme: 'dark', embedImages: false })
    expect(light.rootVars).not.toBe(dark.rootVars)
    expect(dark.rootVars).toContain('#1e252d')
  })

  it('keeps the standalone file complete: every part still lands in the document', async () => {
    const parts = await buildExportParts({ theme: 'light', embedImages: false })
    const out = await buildStandaloneHtml({ theme: 'light', embedImages: false })
    // The faces are in the document (a standalone file registers its own fonts)...
    expect(out).toContain('@font-face')
    expect(out).toContain(parts.fontCss.slice(0, 40))
    // ...the layout rules are in the document...
    expect(out).toContain('.katex')
    // ...the tokens land on :root...
    expect(out).toContain(':root {')
    expect(out).toContain('--md-pre-bg:')
    // ...the container lands on body...
    expect(out).toContain(`body{${parts.containerCss}}`)
    // ...and the print rules travel with it.
    expect(out).toContain('@media print')
  })

  it('rewrites appdoc:// to a relative path when NOT inlining (the file ships with images/)', async () => {
    setExportHtml(clean('<img src="appdoc://doc1/pics/a%20b.png">'))
    const parts = await buildExportParts({ theme: 'light', embedImages: false })
    expect(parts.body).toContain('src="pics/a b.png"')
    expect(parts.body).not.toContain('appdoc://')
  })

  it('reuses a pre-built body so a theme-only change skips the image IPC', async () => {
    const embed = vi.fn(async (h: string) => h)
    ;(
      window as unknown as {
        api: { export: { embedImages: typeof embed; write: () => Promise<void> } }
      }
    ).api = {
      export: { embedImages: embed, write: vi.fn(async () => {}) },
    }
    const parts = await buildExportParts({
      theme: 'dark',
      embedImages: true,
      body: '<p>cached body</p>',
    })
    // The expensive half (base64-inlining every local image) is skipped entirely.
    expect(embed).not.toHaveBeenCalled()
    expect(parts.body).toBe('<p>cached body</p>')
    // The theme-dependent half still refreshed.
    expect(parts.theme).toBe('dark')
    expect(parts.rootVars).toContain('#1e252d')
  })

  it('inlines images when asked (the preview always asks: the relative-path form breaks in a shadow root)', async () => {
    setExportHtml(clean('<img src="appdoc://doc1/a.png">'))
    const embed = vi.fn(async (h: string) =>
      h.replace('appdoc://doc1/a.png', 'data:image/png;base64,AA'),
    )
    ;(
      window as unknown as {
        api: { export: { embedImages: typeof embed; write: () => Promise<void> } }
      }
    ).api = {
      export: { embedImages: embed, write: vi.fn(async () => {}) },
    }
    const parts = await buildExportParts({ theme: 'light', embedImages: true })
    expect(embed).toHaveBeenCalled()
    expect(parts.body).toContain('data:image/png;base64,AA')
  })
})
