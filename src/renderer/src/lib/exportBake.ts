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
import { bakeMermaidIntoHtml, ensureAllMermaidPngs } from './mermaidBake'
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
 *
 * The bake is complete only once the diagrams' PNG forms are ALSO in the cache — the
 * synchronous `copy` event swaps each diagram for a `<img data:png>` from that cache, so an
 * incomplete PNG pass is exactly what made the first copy after opening drop diagrams. We
 * therefore publish the baked SVG HTML first (export / print read it) but only flip the
 * "complete" marker after the PNGs are warm (§4.3 / fix for the missing-diagrams bug).
 *
 * Export and print consume only the SVG HTML, never the PNG cache — so a reviewer may ask
 * why they also `await` the PNG rasterization below instead of returning early. We do NOT
 * split a PNG-free path: the background `scheduleExportBake` pass already warms the cache,
 * so that await is a no-op on the common read-then-export/print path (only the narrow
 * open-heavy-doc-then-export-within-~1s window would pay for it). Splitting would require a
 * second "SVG-ready" completion marker alongside the PNG-ready one, and letting export flip
 * "complete" without the PNGs warm would let a later copy re-emit placeholder diagrams — the
 * dropped-diagrams bug returns. One marker, one source of truth; keep it that way.
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
      // Capture the "this is still the HTML we started from" decision BEFORE publishing, because
      // setExportHtml mutates the canonical HTML. A re-parse that landed mid-bake has already reset
      // the cache to placeholders and will schedule its own pass, so writing now would publish a
      // stale document — in that case we skip both publishing and the "complete" marker.
      const stillSameDoc = getExportHtml() === html
      if (stillSameDoc) {
        setExportHtml(clean)
      }
      // Await the PNG rasterization so the synchronous copy event finds every diagram in
      // `mermaidPngCache`. This is the part that used to be fire-and-forget, leaving the
      // first copy racing the rasterization. The bake is cache-first, so this only touches
      // diagrams not yet rendered, and the background pass (scheduleExportBake) already runs
      // it — the common "read then copy" path never waits here.
      await ensureAllMermaidPngs(getExportMermaidSlots())
      // Mark complete only once the PNG cache is warm, so `needsExportBake()` stays the
      // single "is the copy payload fully ready?" gate until then — and only for the document
      // we actually published.
      if (stillSameDoc) {
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
