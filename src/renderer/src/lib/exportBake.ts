// Complete the canonical export HTML (ADR 0019).
//
// The preview bakes mermaid lazily, one placeholder at a time, as each scrolls into view
// (D-E①, plan-03 §4.3). Export / print / copy must NOT depend on that: they need the whole
// document, not whatever happens to be on screen. This module bakes every slot into the
// canonical HTML MarkdownPreview stashed in `exportStore`, runs it back through the single
// sanitization gate, and publishes the result — so all three output paths read one
// complete, sanitized string while the preview stays lazy.
//
// It is cheap by construction: baking is cache-first by content hash, so only diagrams the
// preview has never rendered actually cost a render (a re-parse of an unchanged document
// is cache hits + one string reassembly).
import { sanitizeHtml } from './sanitize'
import { getExportHtml, setExportHtml, getExportMermaidSlots } from './exportStore'
import { bakeMermaidIntoHtml } from './mermaidBake'
import { t } from '../i18n'

// The HTML we last published, so callers that CANNOT await (the synchronous `copy` handler)
// can still tell whether the cache is already complete without yielding a microtask.
let completedHtml: string | null = null
// One bake at a time: a background pass and a user-triggered export share the in-flight
// promise instead of racing to write the cache.
let inFlight: Promise<string> | null = null

/**
 * Synchronous "does the cache still need baking?" — for callers that must not yield
 * (the `copy` event handler). False for documents without diagrams and for a cache that is
 * already complete, which is the common case, so the copy path stays synchronous.
 */
export function needsExportBake(): boolean {
  const html = getExportHtml()
  if (!html || getExportMermaidSlots().length === 0) return false
  return html !== completedHtml
}

/**
 * Bake every mermaid diagram into the canonical export HTML and publish it. Idempotent,
 * cheap when the cache is warm, and safe to call from the preview (background), the
 * export dialog, the print handler and the copy path.
 */
export async function prepareExportHtml(): Promise<string> {
  const html = getExportHtml()
  if (!html || getExportMermaidSlots().length === 0) return html
  if (html === completedHtml) return html
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const baked = await bakeMermaidIntoHtml(html, getExportMermaidSlots(), t)
      const clean = sanitizeHtml(baked)
      // Publish only when the canonical HTML is still the one we started from: a re-parse
      // in between has already reset the cache to placeholders and will schedule its own
      // pass, so writing now would publish a stale document.
      if (getExportHtml() === html) {
        setExportHtml(clean)
        completedHtml = clean
      }
      return clean
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

let bakeTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Schedule the complete bake for when parsing settles. The bake is cache-first, but a
 * document full of never-rendered diagrams is still real work — deferring it keeps that work
 * off the keystroke that triggered the parse (measured: ~100-200ms of per-keystroke latency
 * when it ran inline). Repeat calls coalesce, so typing does not queue one bake per key.
 */
export function scheduleExportBake(delayMs = 300): void {
  if (bakeTimer) clearTimeout(bakeTimer)
  bakeTimer = setTimeout(() => {
    bakeTimer = null
    void prepareExportHtml()
  }, delayMs)
}

/** Test/diagnostic escape hatch: forget any in-flight bake and completed marker. */
export function resetExportBake(): void {
  if (bakeTimer) clearTimeout(bakeTimer)
  bakeTimer = null
  inFlight = null
  completedHtml = null
}
