import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildStandaloneHtml } from './export'
import { setExportContent, setExportHtml } from './exportStore'

type ExportHtmlArg = Parameters<typeof setExportHtml>[0]

function seed(markdown: string, html: string): void {
  setExportContent(markdown)
  // SanitizedHtml is a branded string; emit a real string cast to the brand for the test seed.
  setExportHtml(html as unknown as ExportHtmlArg)
}

const SAMPLE_MD = '# Heading\n\nSome text with `inline` and a list:\n\n- a\n- b\n'
const SAMPLE_HTML =
  '<h1>Heading</h1><p>Some text with <code>inline</code> and a list:</p><ul><li>a</li><li>b</li></ul>'

/**
 * The app's token values, read straight from globals.css. The export injects the SAME values
 * into its own document, so a drift between the two files is a real parity break — this is
 * exactly the invariant C33b exists to hold (C33a alone would let the two drift apart again).
 */
function appTokens(theme: 'light' | 'dark'): { preBg: string; preBorder: string } {
  const css = readFileSync('src/renderer/src/styles/globals.css', 'utf-8')
  const block =
    theme === 'light'
      ? css.slice(css.indexOf(':root {'), css.indexOf('.dark {'))
      : css.slice(css.indexOf('.dark {'))
  const read = (name: string): string => {
    const m = block.match(new RegExp(`${name}:\\s*([^;]+);`))
    if (!m) throw new Error(`token ${name} not found in the ${theme} block of globals.css`)
    return m[1].trim()
  }
  return { preBg: read('--color-surface-overlay'), preBorder: read('--color-border') }
}

describe('C33 — export preview parity (single source of truth)', () => {
  it('carries markdown-body + theme attributes and inlines the shared markdown-body CSS', async () => {
    seed(SAMPLE_MD, SAMPLE_HTML)
    const out = await buildStandaloneHtml({ theme: 'light', embedImages: false })

    // The host element carries BOTH the class and the theme signal on the SAME tag: the dark
    // hljs palette in markdownExport.css scopes to `.markdown-body[data-theme='dark']`, so a
    // `data-theme` on <html> alone would leave the dark tokens unstyled in the export.
    // (data-color-mode stays on <html> for github-markdown-css.)
    expect(out).toMatch(/<body class="markdown-body" data-theme="light">/)
    expect(out).toContain('data-color-mode="light"')

    // The shared overrides (markdownExport.css) are inlined — single source with the live preview.
    expect(out).toContain('--md-pre-bg')
    expect(out).toContain('content: none')
  })

  it('inlines the highlight.js palette so exported code blocks match the preview', async () => {
    seed(SAMPLE_MD, SAMPLE_HTML)
    const out = await buildStandaloneHtml({ theme: 'light', embedImages: false })
    // github.css (light hljs) is inlined.
    expect(out).toContain('.hljs-keyword')
  })

  it('applies the dark hljs palette and still inlines everything when theme is dark', async () => {
    seed(SAMPLE_MD, SAMPLE_HTML)
    const out = await buildStandaloneHtml({ theme: 'dark', embedImages: false })
    expect(out).toMatch(/<body class="markdown-body" data-theme="dark">/)
    expect(out).toContain(".markdown-body[data-theme='dark'] .hljs-keyword")
    expect(out).toContain('--md-pre-bg')
  })

  it('inlines KaTeX fonts so the standalone file has no dangling relative font urls (D4)', async () => {
    seed(SAMPLE_MD, SAMPLE_HTML)
    const out = await buildStandaloneHtml({ theme: 'light', embedImages: false })
    // No relative font reference survives — the file is genuinely self-contained.
    expect(out).not.toContain('url(fonts/')
    // Positive check: fonts were actually inlined as data URLs (all woff2/woff/ttf formats).
    // Vite's `?inline` MIME is `font/woff` for the woff2 files here, so assert on the stable prefix.
    expect(out).toContain('data:font/woff')
  })

  it('injects the SAME code-block box values the app uses (C33b invariant)', async () => {
    // The export must not carry its own copy of the pre-box colours: if it did, a change to
    // --color-surface-overlay would move the preview and leave the export behind.
    for (const theme of ['light', 'dark'] as const) {
      seed(SAMPLE_MD, SAMPLE_HTML)
      const out = await buildStandaloneHtml({ theme, embedImages: false })
      const { preBg, preBorder } = appTokens(theme)
      expect(out, `${theme}: --md-pre-bg must equal --color-surface-overlay`).toContain(
        `--md-pre-bg: ${preBg};`,
      )
      expect(out, `${theme}: --md-pre-border must equal --color-border`).toContain(
        `--md-pre-border: ${preBorder};`,
      )
    }
  })

  it('inlines the rules that used to live only in globals.css (parity of the shared file)', async () => {
    // `.markdown-body pre.hljs` and the GFM task-list rules were app-only until they moved into
    // markdownExport.css; if they ever move back, the export silently loses them again.
    seed(SAMPLE_MD, SAMPLE_HTML)
    const out = await buildStandaloneHtml({ theme: 'light', embedImages: false })
    expect(out).toContain('.markdown-body pre.hljs')
    expect(out).toContain("input[type='checkbox']")
  })

  it('keeps globals.css free of duplicated .markdown-body overrides (single source of truth)', async () => {
    // globals.css must only bridge the VALUES (--md-pre-*); every RULE lives in
    // markdownExport.css. A second copy here would be a second source of truth.
    const css = readFileSync('src/renderer/src/styles/globals.css', 'utf-8')
    expect(css).not.toMatch(/^\.markdown-body pre\s*\{/m)
    expect(css).not.toMatch(/^\.markdown-body code::before/m)
    expect(css).not.toMatch(/^\.markdown-body\[data-theme='dark'\]/m)
    // The value bridge must stay.
    expect(css).toContain('--md-pre-bg: var(--color-surface-overlay);')
  })
})
