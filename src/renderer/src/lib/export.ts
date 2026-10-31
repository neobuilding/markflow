// Export orchestration (R7): reuse the preview's "sanitized HTML" single source of truth to assemble a standalone .html file.
// Only handles CSS/theme inlining and the image strategy; does not reimplement any Markdown rendering (rendering is done in MarkdownPreview).
import githubCss from 'github-markdown-css/github-markdown.css?raw' // light
import githubDarkCss from 'github-markdown-css/github-markdown-dark.css?raw' // dark
import katexCssRaw from 'katex/dist/katex.min.css?raw'
// C33a: single source of truth for .markdown-body overrides + dark hljs palette, shared with the
// live preview (main.tsx imports the same file). The preview maps --md-pre-* to the app tokens;
// here we inject the ADR-0024 §1.1 values directly so the exported box matches the preview box.
import markdownExportCssRaw from '../styles/markdownExport.css?raw'
import hljsCssRaw from 'highlight.js/styles/github.css?raw'

// vitest cannot load .css text through `?raw`/`?inline` (it returns ''), so under the test runner we
// read the real files from disk. In the production Vite build the `?raw` imports above are populated
// and this branch is statically eliminated (import.meta.env.MODE === 'test' is false), so `node:fs`
// never reaches the browser bundle.
const isTestRunner = import.meta.env.MODE === 'test'

async function readCssFromDisk(repoRelativePath: string): Promise<string> {
  if (!isTestRunner) return ''
  // `as string` keeps TS from resolving the module type (renderer has no node types);
  // `@vite-ignore` keeps Vite from bundling it. This branch is statically eliminated in the
  // production build (import.meta.env.MODE === 'test' is false), so it never reaches the browser.
  const { readFileSync } = await import(/* @vite-ignore */ 'node:fs' as string)
  // Under the test runner cwd is the project root, so repo-relative paths resolve directly.
  const cwd = (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.() ?? ''
  return readFileSync(`${cwd}/${repoRelativePath}`, 'utf-8')
}

async function resolveExportCss(): Promise<{
  markdownExportCss: string
  hljsCss: string
  katexCss: string
}> {
  const [markdownExportCss, hljsCss, katexCss] = await Promise.all([
    markdownExportCssRaw || readCssFromDisk('src/renderer/src/styles/markdownExport.css'),
    hljsCssRaw || readCssFromDisk('node_modules/highlight.js/styles/github.css'),
    katexCssRaw || readCssFromDisk('node_modules/katex/dist/katex.min.css'),
  ])
  return { markdownExportCss, hljsCss, katexCss }
}

// C33a (D4): katex.min.css references fonts via relative `url(fonts/X.woff2)` which 404s once the
// HTML is distributed as a single file. Eager-import every font (woff2/woff/ttf — the CSS references
// all three formats per @font-face) as a base64 data URL at build time and rewrite every reference so
// the export is genuinely self-contained.
const katexFonts = import.meta.glob(
  [
    '/node_modules/katex/dist/fonts/*.woff2',
    '/node_modules/katex/dist/fonts/*.woff',
    '/node_modules/katex/dist/fonts/*.ttf',
  ],
  { query: '?inline', import: 'default', eager: true },
) as Record<string, string>
import { getExportHtml, getExportContent } from './exportStore'
import { resolveExportLang } from './lang'

// Resolve the final export/print theme: 'current' follows the UI theme; 'system' uses matchMedia to get the real dark/light.
// Extracted into a shared function so printing (App.tsx) and exporting HTML (ExportDialog) don't diverge on 'system' theme resolution.
export function resolveTheme(
  choice: 'current' | 'light' | 'dark',
  uiTheme: string,
): 'light' | 'dark' {
  if (choice !== 'current') return choice
  if (uiTheme === 'system') {
    return typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  }
  return uiTheme === 'dark' ? 'dark' : 'light'
}

// The export document's own container declarations. In the standalone file they land on `body`;
// in the "export preview" (C20 ⑨) the same declarations are applied to the preview container,
// because `body` does not match inside a shadow root.
const EXPORT_CONTAINER_CSS =
  'padding:24px;width:100%;max-width:none;margin:0;box-sizing:border-box;'

// The print rules travel with the export (they are what a PDF / system print dialog sees).
const EXPORT_PRINT_CSS = `@media print{
  /* Match the preview (github-markdown-css) on print: headings have no bottom border */
  .markdown-body h1,.markdown-body h2{border-bottom:none;padding-bottom:0;}
  /* GitHub styles use ::before/::after for clearfix; some print engines render a thin line at the top of the page, so disable on print */
  .markdown-body::before,.markdown-body::after{display:none;content:none;}
  /* Restore hr to GitHub's default solid gray bar (0.25em background fill),
     since a 1px transparent light-gray border is nearly invisible when printing a PDF / system dialog with background printing off by default.
     Use print-color-adjust: exact to force Chromium to print that background color, avoiding a disappearing hr. */
  .markdown-body hr{
    display:block;
    height:0.25em;
    margin:1.5em 0;
    padding:0;
    background:var(--borderColor-default);
    border:0;
    overflow:hidden;
    break-inside:avoid;
    page-break-inside:avoid;
    -webkit-print-color-adjust:exact;
    print-color-adjust:exact;
  }
  .markdown-body hr::before,.markdown-body hr::after{display:none !important;content:none !important;}
}`

// KaTeX's sheet carries BOTH the @font-face declarations and the layout rules. A shadow root
// does NOT register fonts (Chromium only picks up @font-face rules that live in the host
// document), so the two halves have to travel separately: the faces go to the host document,
// the layout rules stay with the document CSS.
//
// Deliberately a factory rather than a module-level `/g` literal: a global regex carries
// `lastIndex` state, so `match()` + `replace()` sharing one instance works only because both
// reset it. Handing out a fresh instance per call removes that implicit coupling.
function katexFontFaceRe(): RegExp {
  return /@font-face\{[^}]*\}/g
}

/**
 * The export's parts, split so a second consumer can render the very same document.
 *
 * `buildStandaloneHtml()` assembles a full HTML file from these parts, and the export preview
 * (C20 ⑨) renders them into a shadow root — so the preview shows the EXPORT's own styles, not
 * the app's. One source of truth, two consumers.
 */
export interface ExportParts {
  /** The resolved theme of the export. */
  theme: 'light' | 'dark'
  /** The BCP 47 language tag for the document. */
  lang: string
  /** The sanitized HTML body. */
  body: string
  /** The document stylesheets: base + hljs + the shared .markdown-body overrides + KaTeX layout + print rules. */
  css: string
  /** The @font-face declarations (KaTeX, fonts inlined as data URLs). Must live in the HOST document. */
  fontCss: string
  /** The document-level custom properties (`--md-pre-*`); `:root` in the export, `:host` in a shadow root. */
  rootVars: string
  /** The container declarations (the export's `body{...}`). */
  containerCss: string
  /** The @media print rules. */
  printCss: string
}

/**
 * Build the export BODY only: the sanitized HTML plus the image strategy.
 *
 * The body does not depend on the theme, so a consumer that re-renders on a theme change (the
 * export preview) can build it once and hand it back through `buildExportParts({ body })` instead
 * of re-running the image IPC on every toggle.
 */
export async function buildExportBody(opts: { embedImages: boolean }): Promise<string> {
  // Deliberately widened to `string`: the value coming out of the store is branded
  // `SanitizedHtml`, but the transforms below (base64 inlining / appdoc→relative
  // rewriting) produce a NEW string that no longer carries that guarantee — and this
  // body is written to disk / handed to the print IPC, never injected into the
  // preview DOM, so it must not be laundered back into `SanitizedHtml`.
  let body: string = getExportHtml()
  if (opts.embedImages) {
    // Inline images as base64 into a single file (works offline); on failure keep the original src.
    body = await window.api.export.embedImages(body)
  } else {
    // Non-inline: restore appdoc:// to a relative path (shipped with images/), keep remote https as-is.
    body = body.replace(
      /src="appdoc:\/\/[^/]+\/([^"]+)"/g,
      (_m, p1) => `src="${decodeURIComponent(p1)}"`,
    )
  }
  return body
}

/**
 * Build the export's parts. This is the single source of truth for both the standalone file and
 * the export preview (C20 ⑨).
 *
 * `body` is optional: pass a previously built body to skip the (theme-independent) image work when
 * only the theme changed.
 */
export async function buildExportParts(opts: {
  theme: 'light' | 'dark'
  embedImages: boolean
  body?: string
}): Promise<ExportParts> {
  const body = opts.body ?? (await buildExportBody({ embedImages: opts.embedImages }))
  // C33a: resolve the shared override + hljs + katex CSS text (disk fallback only under the test runner).
  const { markdownExportCss, hljsCss, katexCss } = await resolveExportCss()
  const baseCss = opts.theme === 'dark' ? githubDarkCss : githubCss
  // resolveExportLang always resolves to a non-empty BCP 47 tag (frontmatter → content detection → 'en'),
  // so no further fallback is needed here.
  const lang = await resolveExportLang(getExportContent())
  // Split the KaTeX sheet: the @font-face blocks go to the host document (a shadow root does
  // not register fonts), the layout rules stay with the document CSS.
  const katexLayout = katexCss.replace(katexFontFaceRe(), '')
  // C33a (D4): inline every KaTeX woff2 as a base64 data URL so the single-file export doesn't dangle
  // relative `fonts/*.woff2` references (they 404 once the HTML leaves the app).
  let inlinedFonts = (katexCss.match(katexFontFaceRe()) ?? []).join('\n')
  for (const [fontPath, dataUrl] of Object.entries(katexFonts)) {
    const name = fontPath.split('/').pop()!
    inlinedFonts = inlinedFonts.split(`fonts/${name}`).join(dataUrl)
  }
  // C33a: the shared .markdown-body overrides + dark hljs palette, with the export-scoped --md-pre-*
  // tokens injected (ADR-0024 §1.1) so the exported code-block box matches the live preview exactly.
  const rootVars = `  --md-pre-bg: ${opts.theme === 'dark' ? '#1e252d' : '#edf2f9'};\n  --md-pre-border: ${opts.theme === 'dark' ? '#2a323b' : '#e2e8f0'};`
  return {
    theme: opts.theme,
    lang,
    body,
    css: `${baseCss}\n${hljsCss}\n${markdownExportCss}\n${katexLayout}`,
    fontCss: inlinedFonts,
    rootVars,
    containerCss: EXPORT_CONTAINER_CSS,
    printCss: EXPORT_PRINT_CSS,
  }
}

// Assemble the standalone HTML (same logic as exporting HTML). PDF and HTML export share this function,
// and it also settles the naming (it was originally called buildStandaloneHtml).
// Export is uniformly UTF-8: meta charset is fixed to utf-8, matching writeFileSync(..., 'utf-8') byte-for-byte,
// so non-UTF-8 documents (GBK/Big5 etc.) won't be misread by the browser under their original encoding and garble (R5 export byte fidelity).
export async function buildStandaloneHtml(opts: {
  theme: 'light' | 'dark'
  embedImages: boolean
}): Promise<string> {
  const parts = await buildExportParts(opts)
  return `<!doctype html>
<html lang="${parts.lang}" data-color-mode="${parts.theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; object-src 'none'; base-uri 'none'">
<title>Exported Markdown</title>
<style>${parts.css}</style>
<style>:root {
${parts.rootVars}
}</style>
<style>${parts.fontCss}</style>
<style>body{${parts.containerCss}}</style>
<style>${parts.printCss}</style>
</head>
<body class="markdown-body" data-theme="${parts.theme}">
${parts.body}
</body>
</html>`
}

export async function exportDocument(opts: {
  path: string
  theme: 'light' | 'dark'
  embedImages: boolean
  overwrite?: boolean
}): Promise<void> {
  const html = await buildStandaloneHtml({ theme: opts.theme, embedImages: opts.embedImages })
  await window.api.export.write(opts.path, html, opts.overwrite ?? false)
}
