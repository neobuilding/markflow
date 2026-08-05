// Export orchestration (R7): reuse the preview's "sanitized HTML" single source of truth to assemble a standalone .html file.
// Only handles CSS/theme inlining and the image strategy; does not reimplement any Markdown rendering (rendering is done in MarkdownPreview).
import githubCss from 'github-markdown-css/github-markdown.css?raw' // light
import githubDarkCss from 'github-markdown-css/github-markdown-dark.css?raw' // dark
import katexCss from 'katex/dist/katex.min.css?raw'
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

// Assemble the standalone HTML (same logic as exporting HTML). PDF and HTML export share this function,
// and it also settles the D1 naming (the plan originally called it buildStandaloneHtml).
// Export is uniformly UTF-8: meta charset is fixed to utf-8, matching writeFileSync(..., 'utf-8') byte-for-byte,
// so non-UTF-8 documents (GBK/Big5 etc.) won't be misread by the browser under their original encoding and garble (R5 export byte fidelity).
export async function buildStandaloneHtml(opts: {
  theme: 'light' | 'dark'
  embedImages: boolean
}): Promise<string> {
  let body = getExportHtml()
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
  const css = opts.theme === 'dark' ? githubDarkCss : githubCss
  // resolveExportLang always resolves to a non-empty BCP 47 tag (frontmatter → content detection → 'en'),
  // so no further fallback is needed here.
  const lang = resolveExportLang(getExportContent())
  return `<!doctype html>
<html lang="${lang}" data-theme="${opts.theme}" data-color-mode="${opts.theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; object-src 'none'; base-uri 'none'">
<title>Exported Markdown</title>
<style>${css}</style>
<style>${katexCss}</style>
<style>
body{padding:24px;width:100%;max-width:none;margin:0;box-sizing:border-box;}
@media print{
  /* Match the preview (Tailwind prose) on print: headings have no bottom border */
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
}
</style>
</head>
<body class="markdown-body">
${body}
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
