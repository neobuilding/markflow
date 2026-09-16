// Single source of truth for the "sanitized preview HTML" used by export (a
// non-reactive singleton to avoid store churn). MarkdownPreview writes it after
// parsing; export reads it directly, reusing the same sanitized, Mermaid/KaTeX-
// injected HTML so the output is WYSIWYG and we don't re-implement render logic
// for export (R7).
//
// The stored value is typed `SanitizedHtml`, so the brand survives the round-trip:
// whatever export / stage-2 rich-text copy reads back is provably the output of the
// single sanitization gate (Plan 01 §5.5 contract #2).
import { sanitizeHtml, type SanitizedHtml } from './sanitize'

let current: SanitizedHtml = sanitizeHtml('')

export function setExportHtml(html: SanitizedHtml): void {
  current = html
}

export function getExportHtml(): SanitizedHtml {
  return current
}

// Source for the exported HTML's <html lang>: cache the raw markdown (including
// frontmatter) string reference and compute it once at export/print time via
// resolveExportLang (now async; lazy-loads franc only when exporting), so franc is
// not run — or even imported — during preview parsing
// (it is only needed for export).
let currentMarkdown = ''

export function setExportContent(markdown: string): void {
  currentMarkdown = markdown
}

export function getExportContent(): string {
  return currentMarkdown
}
