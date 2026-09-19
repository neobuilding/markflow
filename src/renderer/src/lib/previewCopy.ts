// Rich-text copy for the preview pane (Plan 02 §4).
//
import { getExportHtml } from './exportStore'
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
// Phase 1 (§5.5) lists five internal markers: data-line, data-mermaid-slot,
// data-mermaid-source, data-lang, data-baked. A sixth is `tabindex`: markdown-it-anchor's
// defaults set `tabIndex: "-1"` on EVERY heading (we call `md.use(anchor)` with no options),
// purely so permalink anchors can take focus — author-invisible noise that would otherwise be
// pasted onto every heading. Verified against the real clipboard in
// e2e/specs/context-menu.e2e.spec.ts ("…lands a clean payload").
const INTERNAL_ATTRS = [
  'data-line',
  'data-mermaid-source',
  'data-mermaid-slot',
  'data-lang',
  'data-baked',
  'tabindex',
]

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

// Pure builder: produce the clean { text, html } payload for the current preview state.
// Selection-priority, whole-article fallback, cross-pane guard (§4.1 / §4.2).
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
    // No in-preview selection → whole article. Phase 1 contract #2 delivers a canonical,
    // single-sanitized HTML (already mermaid/KaTeX-baked, appdoc:// srcs preserved, no
    // runtime UI injection such as data-baked) as the single source of truth. Prefer it
    // over scraping article.innerHTML, which can carry browser normalization and runtime
    // markers and would re-derive the payload Stage 2 was told to reuse (§5.5).
    const canonical = getExportHtml()
    html = canonical && canonical.length > 0 ? canonical : article.innerHTML
    text = htmlToText(html)
  }
  return { text, html: stripInternalAttrs(html) }
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

// Menu entry point: build the payload, inline images when present (async), then trigger the
// native `copy` event which the article's `onCopy` handler writes. The menu and keyboard
// paths converge on that single handler, so output is identical (R3). The current selection
// is restored afterwards so a right-click "Copy" never leaves the whole article selected.
export async function requestRichCopy(article: HTMLElement): Promise<void> {
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
  if (typeof document.execCommand === 'function') {
    try {
      document.execCommand('copy')
    } catch {
      /* execCommand blocked — native copy won't fire; pendingCopy cleared below */
    }
  }
  pendingCopy = null

  // Restore the user's original selection so the visible selection state is unchanged.
  if (!selInPreview && sel) {
    sel.removeAllRanges()
    /* v8 ignore next -- defensive: prevRange is non-null whenever selInPreview was false;
       this path is unreachable under jsdom unit tests */
    if (prevRange) sel.addRange(prevRange)
  }
}

// Rasterize an SVG string to a PNG `data:` URL so it can be copied as a bitmap via
// `clipboard:write-image` (§4.4). Runs entirely on the renderer using an offscreen <img> +
// <canvas>. Used by the mermaid "Copy Image" item; the result is a `data:image/png;base64,…`
// URL, which is why `clipboard:write-image` was extended to accept `data:` URLs.
/* v8 ignore start: svgToPngDataUrl + svgPixelSize drive a real <img>/<canvas> rasterization
   pipeline that jsdom cannot execute (no Image.onload, no 2d context, no toDataURL). Both the
   PNG and SVG-size paths are exercised by the e2e suite (context-menu.e2e.spec.ts) in a real
   browser, so they are held out of unit line/branch coverage. */
export async function svgToPngDataUrl(svg: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svg], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      const { width, height } = svgPixelSize(svg, img)
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(width))
      canvas.height = Math.max(1, Math.round(height))
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        URL.revokeObjectURL(url)
        reject(new Error('no 2d context'))
        return
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('svg rasterization failed'))
    }
    img.src = url
  })
}

// Resolve the pixel size to rasterize at. SVG often has no intrinsic size, so prefer the
// parsed `viewBox` / width / height attributes; fall back to a default canvas when absent.
function svgPixelSize(svg: string, img: HTMLImageElement): { width: number; height: number } {
  if (img.naturalWidth > 0 && img.naturalHeight > 0) {
    return { width: img.naturalWidth, height: img.naturalHeight }
  }
  try {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const el = doc.documentElement
    const vb = el.getAttribute('viewBox')
    if (vb) {
      const parts = vb.split(/[\s,]+/).map(Number)
      if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
        return { width: parts[2], height: parts[3] }
      }
    }
    const aw = parseFloat(el.getAttribute('width') ?? '')
    const ah = parseFloat(el.getAttribute('height') ?? '')
    if (aw > 0 && ah > 0) return { width: aw, height: ah }
  } catch {
    /* ignore parse errors */
  }
  return { width: 800, height: 600 }
}
/* v8 ignore stop */
