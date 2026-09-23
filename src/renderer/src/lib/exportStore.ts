// Single source of truth for the "sanitized preview HTML" used by export (a
// non-reactive singleton to avoid store churn). MarkdownPreview writes it after
// parsing; export reads it directly, reusing the same sanitized, Mermaid/KaTeX-
// injected HTML so the output is WYSIWYG and we don't re-implement render logic
// for export (R7).
//
// The stored value is typed `SanitizedHtml`, so the brand survives the round-trip:
// whatever export / stage-2 rich-text copy reads back is provably the output of the
// single sanitization gate (Plan 01 §5.5 contract #2).
// ADR 0019: the export cache holds the sanitized preview HTML *plus the mermaid slots it
// was parsed from*, because the preview no longer bakes diagrams into the string — the
// complete bake (export/print/copy) needs the diagram SOURCE, not just the placeholders.
import { sanitizeHtml, type SanitizedHtml } from './sanitize'
import type { MermaidSlot } from './markdownPipeline'

let current: SanitizedHtml = sanitizeHtml('')

export function setExportHtml(html: SanitizedHtml): void {
  current = html
}

export function getExportHtml(): SanitizedHtml {
  return current
}

let currentSlots: MermaidSlot[] = []

/** Stash the mermaid sources the current export HTML was parsed from (see ADR 0019). */
export function setExportMermaidSlots(slots: MermaidSlot[]): void {
  currentSlots = slots
}

export function getExportMermaidSlots(): MermaidSlot[] {
  return currentSlots
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
