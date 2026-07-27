// Single source of truth for the "sanitized preview HTML" used by export (a
// non-reactive singleton to avoid store churn). MarkdownPreview writes it after
// parsing; export reads it directly, reusing the same sanitized, Mermaid/KaTeX-
// injected HTML so the output is WYSIWYG and we don't re-implement render logic
// for export (R7).
let current = ''

export function setExportHtml(html: string): void {
  current = html
}

export function getExportHtml(): string {
  return current
}

// Source for the exported HTML's <html lang>: cache the raw markdown (including
// frontmatter) string reference and compute it once at export/print time via
// resolveExportLang, so franc is not run repeatedly during preview parsing
// (it is only needed for export).
let currentMarkdown = ''

export function setExportContent(markdown: string): void {
  currentMarkdown = markdown
}

export function getExportContent(): string {
  return currentMarkdown
}
