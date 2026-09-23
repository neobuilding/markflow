// Rich-text copy for the preview pane (Plan 02 §4).
//
import { getExportHtml } from './exportStore'
import { prepareExportHtml, needsExportBake } from './exportBake'
import { hasUnresolvedDiagram } from './mermaidBake'
//
// Strategy (decision D10 = option iii): we never construct the clipboard payload on the
// main-process side. Instead the actual write happens inside the `copy` event handler
// attached to the preview `<article>` (`e.clipboardData.setData`), which is synchronous and
// lets the browser pack both `text/plain` and `text/html` for us. The keyboard path (native
// Ctrl+C) and the right-click menu path therefore share one writer and one payload builder,
// so the two can never diverge (R3).
//
// Because the `copy` event is synchronous but image inlining (`embedImages`) is async, the
// menu path uses a "pending payload" pattern: `requestRichCopy` prepares the payload
// (awaiting image inlining), stashes it in `pendingCopy`, then fires `execCommand('copy')`
// which synchronously dispatches the `copy` event; the handler consumes `pendingCopy`. The
// keyboard path has no pending payload, so the handler builds it live from the current DOM.

// Attributes that are internal to markflow's render pipeline and must not leak into the
// rich-text HTML the user pastes into Word / Confluence / Excel / Notion.
// Phase 1 (§5.5) lists four internal markers: data-line, data-mermaid-slot, data-lang,
// data-baked. A fifth is `tabindex`: markdown-it-anchor's defaults set `tabIndex: "-1"` on
// EVERY heading (we call `md.use(anchor)` with no options), purely so permalink anchors can
// take focus — author-invisible noise that would otherwise be pasted onto every heading.
// Verified against the real clipboard in e2e/specs/context-menu.e2e.spec.ts ("…lands a clean payload").
// (data-mermaid-source was removed per plan-02 D3/D9 — the "Copy diagram source" menu item no
// longer exists, so its attribute must not be reintroduced.)
const INTERNAL_ATTRS = ['data-line', 'data-mermaid-slot', 'data-lang', 'data-baked', 'tabindex']

// Remove the pipeline's internal attributes from a copy payload so pasted HTML is clean
// (R6). Operates on a detached node so it never touches the live preview DOM.
export function stripInternalAttrs(html: string): string {
  if (!html) return html
  const tmp = document.createElement('div')
  tmp.innerHTML = html
  tmp.querySelectorAll(INTERNAL_ATTRS.map((a) => `[${a}]`).join(',')).forEach((el) => {
    for (const a of INTERNAL_ATTRS) el.removeAttribute(a)
  })
  return tmp.innerHTML
}

// True only when the current selection lives inside the given preview article. A selection
// made in the *editor* pane (anchor outside the article) must NOT be used for preview copy —
// otherwise right-clicking the preview with editor text selected would copy the editor text
// (cross-pane mis-copy, §4.2).
function selectionIsInPreview(article: HTMLElement): boolean {
  const sel = window.getSelection()
  return !!(
    sel &&
    !sel.isCollapsed &&
    sel.rangeCount > 0 &&
    sel.anchorNode &&
    article.contains(sel.anchorNode)
  )
}

// Pure builder: produce the { text, html } payload for the current preview state. The HTML is
// returned UN-STRIPPED (internal markers such as data-mermaid-slot still present) because the
// fidelity layer (enhanceForPaste in copyFidelity.ts) needs them to locate mermaid slots, and
// stripInternalAttrs runs as the final step of that layer. Selection-priority, whole-article
// fallback, cross-pane guard (§4.1 / §4.2).
export function buildPreviewCopyPayload(article: HTMLElement): { text: string; html: string } {
  const selInPreview = selectionIsInPreview(article)
  let text: string
  let html: string
  if (selInPreview) {
    // A live selection inside the preview: clone just that fragment so partial copies
    // keep structure. Range.cloneContents preserves the nested tags (headings, lists,
    // tables, code…) which is exactly what gives us formatted paste (R1).
    const frag = window.getSelection()!.getRangeAt(0).cloneContents()
    const tmp = document.createElement('div')
    tmp.appendChild(frag)
    html = tmp.innerHTML
    text = window.getSelection()!.toString()
  } else {
    // No in-preview selection → whole article. The inlined-image cache (§4.8) is preferred
    // when warm so the keyboard path pastes base64 images (Word-safe) just like the menu
    // path; otherwise the canonical export HTML (ADR 0019, complete bake) is the source of
    // truth, with article.innerHTML as the last-resort fallback.
    const canonical = getExportHtml()
    const base =
      inlinedWholeArticleHtml ?? (canonical && canonical.length > 0 ? canonical : article.innerHTML)
    html = base
    text = htmlToText(base)
  }
  return { text, html }
}

// §4.8 — pre-inlined whole-article HTML cache (appdoc:// → base64) so the synchronous keyboard
// Ctrl+C path pastes embedded images too. Warmed by warmInlinedImages after each render; null
// until then (the keyboard path then degrades to un-inlined images, which is the pre-plan-04
// behaviour and never breaks the copy).
let inlinedWholeArticleHtml: string | null = null

// §4.8 — the same pass also yields an appdoc:// → data: map, so a keyboard copy of a PARTIAL
// SELECTION can rewrite its own <img>s synchronously (that path has no pending payload and the
// whole-article cache above does not cover a fragment).
let inlinedImageMap = new Map<string, string>()

/** Read-only view of the pre-inlined image map (consumed by the copy fidelity layer, §4.8). */
export function getInlinedImageMap(): ReadonlyMap<string, string> {
  return inlinedImageMap
}

/** Forget the pre-inlined image caches (doc switch / re-parse). */
export function resetInlinedImageCache(): void {
  inlinedWholeArticleHtml = null
  inlinedImageMap = new Map()
}

/**
 * Pre-inline every `<img>` in the article to a base64 `data:` URL (§4.8) so the keyboard copy
 * path matches the menu path (R13.7). Fire-and-forget: the result is cached and the copy reads
 * it synchronously. No-op when there are no images or the embed IPC is unavailable (tests).
 *
 * IMPORTANT: the source is the COMPLETE, baked canonical HTML (ADR 0019), never the live
 * `article.innerHTML`. The preview bakes mermaid lazily (only on-screen diagrams), so the live
 * DOM carries EMPTY placeholders for off-screen diagrams — caching that would silently DROP
 * every diagram on paste (the whole-article branch prefers this cache). `prepareExportHtml()`
 * bakes every slot first and is cache-first/idempotent, so this stays cheap.
 */
export async function warmInlinedImages(article: HTMLElement): Promise<void> {
  inlinedWholeArticleHtml = null
  inlinedImageMap = new Map()
  await prepareExportHtml()
  const canonical = getExportHtml()
  const source = canonical && canonical.length > 0 ? canonical : article.innerHTML
  if (!source.includes('<img')) return
  const embed = (
    window as unknown as { api?: { export?: { embedImages?: (h: string) => Promise<string> } } }
  ).api?.export?.embedImages
  if (typeof embed !== 'function') return
  try {
    const inlined = await embed(source)
    inlinedWholeArticleHtml = inlined
    inlinedImageMap = collectInlinedImages(source, inlined)
  } catch {
    /* keep the caches empty: the copy then falls back to the (baked) canonical html */
  }
}

// Pair every <img> of the source with the one embedImages returned. The main-process handler keeps
// the order and the count (it rewrites `src`, or leaves the original tag untouched when inlining
// fails), so zipping by index is exact; on a shape mismatch the map is dropped — the copy then
// pastes un-inlined images instead of embedding the WRONG picture.
function collectInlinedImages(source: string, inlined: string): Map<string, string> {
  const map = new Map<string, string>()
  const from = imgSources(source)
  const to = imgSources(inlined)
  if (from.length !== to.length) return map
  for (let i = 0; i < from.length; i++) {
    const src = from[i]!
    const dataUrl = to[i]!
    if (src.startsWith('data:') || !dataUrl.startsWith('data:')) continue
    map.set(src, dataUrl)
  }
  return map
}

// Raw `src` attributes in document order ('' for an <img> without one, e.g. a relative image whose
// URL was stripped upstream). Raw rather than `img.src`, so the keys match the payload verbatim.
function imgSources(html: string): string[] {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  return Array.from(doc.querySelectorAll('img')).map((img) => img.getAttribute('src') ?? '')
}

// Plain-text projection of an HTML string for the text/plain clipboard half.
function htmlToText(html: string): string {
  const tmp = document.createElement('div')
  tmp.innerHTML = html
  /* v8 ignore next -- Element.textContent is always a string (never null), so the fallback is unreachable */
  return tmp.textContent ?? ''
}

// The pending payload set by the menu path, consumed (and cleared) by the `copy` handler.
let pendingCopy: { text: string; html: string } | null = null

// Read + clear the pending payload. Returns null on the keyboard path (no menu pre-prep).
export function consumePendingCopy(): { text: string; html: string } | null {
  const p = pendingCopy
  pendingCopy = null
  return p
}

/**
 * Fire the native `copy` event. A no-op when the environment lacks execCommand or refuses it —
 * the copy is best-effort and must never throw out of the copy handler.
 */
function fireNativeCopy(): void {
  // Guard: some environments (non-focused webviews, test DOM) lack execCommand entirely.
  if (typeof document.execCommand !== 'function') return
  try {
    document.execCommand('copy')
  } catch {
    /* execCommand blocked — the native copy won't fire and no payload is written */
  }
}

// ── Cold-cache copy retry (fixes "the first copy drops diagrams") ──
//
// The `copy` event is synchronous and cannot await the PNG rasterization the payload needs. When
// the payload carries a diagram whose PNG is missing, the handler defers instead of shipping it:
// `deferWarmCopy` finishes the bake, REBUILDS the payload (the cold-time one still referenced the
// pre-bake placeholders) and re-fires the native copy — which re-enters the handler with a warm
// cache and takes the fast path. `coldCopyArmed` stops the re-fired event from deferring again
// (no infinite loop). This is the only way to guarantee zero dropped diagrams for the "user copies
// within ~1s of opening" edge without blocking the UI.
let coldCopyArmed = false

/**
 * Take over a cold copy. Returns true when the copy was deferred — the caller must then
 * preventDefault and write NOTHING. Deferred only when the payload actually awaits a diagram PNG
 * AND the native copy can be re-fired: in an environment without execCommand, deferring would
 * silently copy nothing at all, which is strictly worse than writing the degraded payload.
 */
export function deferColdCopy(
  article: HTMLElement,
  payload: { text: string; html: string },
): boolean {
  if (coldCopyArmed) return false
  if (!hasUnresolvedDiagram(payload.html)) return false
  if (typeof document.execCommand !== 'function') return false
  coldCopyArmed = true
  void deferWarmCopy(article)
  return true
}

/** Await the complete bake, rebuild the payload, then re-fire the native copy to write it. */
export async function deferWarmCopy(article: HTMLElement): Promise<void> {
  try {
    await prepareExportHtml()
  } catch {
    /* Bake failed: fall through and re-fire anyway, so the handler still writes the best
       payload it has (a failed bake degrades content; it must never swallow the copy). */
  }
  try {
    // Rebuild NOW: the canonical HTML is baked and the PNG cache is warm, so this payload
    // carries every diagram as a PNG. Reusing the cold-time payload (placeholders) would
    // still drop diagrams even after the bake completed.
    pendingCopy = buildPreviewCopyPayload(article)
    fireNativeCopy()
  } finally {
    pendingCopy = null
    coldCopyArmed = false
  }
}

// Menu entry point: build the payload, inline images when present (async), then trigger the
// native `copy` event which the article's `onCopy` handler writes. The menu and keyboard
// paths converge on that single handler, so output is identical (R3). The current selection
// is restored afterwards so a right-click "Copy" never leaves the whole article selected.
export async function requestRichCopy(article: HTMLElement): Promise<void> {
  // ADR 0019: complete the canonical HTML BEFORE building the payload, otherwise a
  // whole-article copy carries empty mermaid placeholders (the preview bakes lazily, so
  // only on-screen diagrams exist in the DOM). Guarded by the synchronous check so a
  // document WITHOUT diagrams never yields here: everything after this point must stay
  // synchronous for the `copy` event to see it.
  // The keyboard path cannot await at all — it reads the same cache, which the preview
  // completes in the background right after each parse.
  if (needsExportBake()) await prepareExportHtml()
  const { text, html } = buildPreviewCopyPayload(article)
  let finalHtml = html
  // Only inline when the fragment actually contains an <img>: avoids needless IPC on text /
  // table / heading copies, and a failed inline falls back to the un-inlined HTML rather than
  // aborting the copy (§4.4).
  if (html.includes('<img')) {
    try {
      finalHtml = await window.api.export.embedImages(html)
    } catch {
      /* keep raw html */
    }
  }
  pendingCopy = { text, html: finalHtml }

  const sel = window.getSelection()
  const selInPreview = selectionIsInPreview(article)
  // Remember the user's real selection so we can restore it after the temporary select-all.
  /* v8 ignore next -- defensive: sel is always present with a range when a copy fires; the null
     fallbacks are unreachable under jsdom unit tests */
  const prevRange = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null

  // When there is no in-preview selection we must select the whole article before copying —
  // but ONLY inside the preview (the guard above already proved the editor selection, if any,
  // is out of scope, so we don't touch it).
  if (!selInPreview) {
    const range = document.createRange()
    range.selectNodeContents(article)
    sel?.removeAllRanges()
    sel?.addRange(range)
  }

  // Fires the `copy` event synchronously → the article's onCopy writes pendingCopy.
  // Guard: some environments (non-focused webviews, test DOM) lack execCommand; if it is
  // unavailable the native copy simply won't fire and the pending payload is cleared below,
  // so we never crash the copy action.
  fireNativeCopy()
  pendingCopy = null

  // Restore the user's original selection so the visible selection state is unchanged.
  if (!selInPreview && sel) {
    sel.removeAllRanges()
    /* v8 ignore next -- defensive: prevRange is non-null whenever selInPreview was false;
       this path is unreachable under jsdom unit tests */
    if (prevRange) sel.addRange(prevRange)
  }
}

// Rasterization now lives in rasterize.ts (shared with copyFidelity / mermaidBake) so the
// copy pipeline and the mermaid bake don't form an import cycle.
export { svgToPngDataUrl } from './rasterize'
