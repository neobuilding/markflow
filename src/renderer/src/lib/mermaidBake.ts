// Mermaid baking — the ONE place mermaid is loaded and rendered (D-E①, plan-03 §4.3).
//
// Two consumers, two shapes, one cache:
//
//   * preview (lazy)  — `renderMermaidSlot` fills a single placeholder in the DOM when it
//                       scrolls into view, so off-screen diagrams cost nothing (ADR 0018).
//   * export / print / copy (complete) — `bakeMermaidIntoHtml` bakes EVERY slot into the
//                       canonical HTML string (ADR 0019).
//
// Both share the content-hash SVG cache below, so a diagram is rendered at most once per
// distinct source: after the preview has rendered the visible ones, the complete pass is
// nearly free (cache hits + a string reassembly).
//
// Keeping this in a lib (not in the component) is what lets export / print / copy bake
// without importing the preview component — see ADR 0019.
import { sanitizeHtml } from './sanitize'
import type { MermaidSlot } from './markdownPipeline'
import type { TranslationKey } from '../../../../shared/i18n/en'

// Mermaid is heavy (~2.5 MB) and only needed when a document actually contains a
// diagram, so it is dynamically imported on first use instead of being bundled into
// the initial preview chunk. The module is cached after the first load.
interface MermaidApi {
  initialize: (config: unknown) => void
  render: (id: string, code: string) => Promise<{ svg: string }>
}
let mermaidReady: Promise<MermaidApi> | null = null

function getMermaid(): Promise<MermaidApi> {
  if (!mermaidReady) {
    mermaidReady = import('mermaid')
      .then((m) => {
        const mod = m.default as unknown as MermaidApi
        mod.initialize({ securityLevel: 'strict', startOnLoad: false, htmlLabels: false })
        return mod
      })
      /* v8 ignore start -- defensive: the import-failure path isn't exercised under jsdom (mermaid is mocked) */
      .catch((err) => {
        mermaidReady = null
        throw err
      })
    /* v8 ignore stop */
  }
  return mermaidReady
}

// Module-level serial queue: mermaid has internal global state (shared id / temp DOM),
// so concurrent renders would corrupt diagrams / throw. All renders are queued.
let mermaidChain: Promise<unknown> = Promise.resolve()
function renderMermaidSvg(id: string, code: string): Promise<{ svg: string }> {
  const task = mermaidChain.then(async () => {
    const mermaid = await getMermaid()
    return mermaid.render(id, code.trim())
  })
  mermaidChain = task.catch(() => undefined) // Keep the chain alive on failure so later renders aren't blocked.
  return task as Promise<{ svg: string }>
}

// D-E① (plan-03 §4.3): cache rendered mermaid SVGs by content hash so re-parses / doc
// switches never re-render an unchanged diagram. The value also stores the SVG height
// for scroll-sync stability (plan-03 §7 #6).
export interface MermaidCacheEntry {
  svg: string
  height?: number
}
export const mermaidSvgCache = new Map<string, MermaidCacheEntry>()

// Read the rendered height from an SVG string (height attr or viewBox) so we can reserve
// space for the placeholder before it renders (avoids scroll jump / CLS).
export function readSvgHeight(svg: string): number | undefined {
  try {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const el = doc.documentElement
    const h = el.getAttribute('height')
    if (h && /^\d+(\.\d+)?$/.test(h)) return Number(h)
    const vb = el.getAttribute('viewBox')
    if (vb) {
      const p = vb.split(/[\s,]+/).map(Number)
      if (p.length === 4 && p[3] > 0) return p[3]
    }
    /* v8 ignore next 2 */
  } catch {
    /* ignore parse errors */
  }
  return undefined
}

export function fillMermaidSlot(el: HTMLElement, entry: MermaidCacheEntry): void {
  el.innerHTML = entry.svg
  el.style.minHeight = entry.height ? `${entry.height}px` : ''
}

// Render one slot, cache-first. Shared by the lazy DOM path and the complete string path,
// which is what guarantees a diagram baked for the preview is never re-rendered for export.
// Throws on a render failure: the two callers decide what a failure looks like (the preview
// shows the skeleton in place, the complete bake puts the same skeleton in the string).
export async function bakeMermaidSlot(info: MermaidSlot): Promise<MermaidCacheEntry> {
  const cached = mermaidSvgCache.get(info.hash)
  if (cached) return cached
  // mermaid needs a collision-free id, but a random one would make the markup differ on
  // every render (N4: morphdom could then never skip an unchanged subtree) — so render
  // with a random id and normalise to a deterministic one before caching.
  const renderId = `mermaid-${info.hash}-${Math.random().toString(36).slice(2)}`
  const stableId = `mermaid-${info.hash}-${info.slot}`
  const out = await renderMermaidSvg(renderId, info.code)
  const raw = out.svg.split(renderId).join(stableId)
  const safe = sanitizeHtml(raw) // sanitize the injected fragment (single gate)
  const entry: MermaidCacheEntry = { svg: safe, height: readSvgHeight(safe) }
  mermaidSvgCache.set(info.hash, entry)
  return entry
}

/** The failure markup for a diagram that cannot be rendered (preview parity, ADR 0019 Q4). */
export function mermaidFailureMarkup(
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  return `<div class="mermaid-skeleton">⚠ ${t('preview.mermaidFailed')}</div>`
}

// Lazy DOM path (preview): fill one placeholder, reusing the cache when possible.
export async function renderMermaidSlot(
  el: HTMLElement,
  slots: MermaidSlot[],
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): Promise<void> {
  const slotAttr = el.getAttribute('data-mermaid-slot')
  if (!slotAttr) return
  const info = slots.find((m) => m.slot === Number(slotAttr))
  if (!info) return
  const cached = mermaidSvgCache.get(info.hash)
  if (cached) {
    fillMermaidSlot(el, cached)
    return
  }
  try {
    fillMermaidSlot(el, await bakeMermaidSlot(info))
  } catch {
    el.innerHTML = mermaidFailureMarkup(t)
  }
}

// Complete string path (export / print / copy, ADR 0019): bake EVERY placeholder in `html`.
//
// Works on a detached DOM rather than a regex so extra placeholder attributes (R6
// `data-line`) and any future attribute survive untouched — only the children change.
// A slot that fails to render degrades to the same skeleton the preview shows, so the
// exported document never silently loses a block.
export async function bakeMermaidIntoHtml(
  html: string,
  slots: MermaidSlot[],
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): Promise<string> {
  if (slots.length === 0) return html
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const nodes = Array.from(doc.querySelectorAll('[data-mermaid-slot]'))
  if (nodes.length === 0) return html
  for (const node of nodes) {
    const info = slots.find((m) => m.slot === Number(node.getAttribute('data-mermaid-slot')))
    if (!info) continue
    let inner: string
    try {
      inner = (await bakeMermaidSlot(info)).svg
    } catch {
      inner = mermaidFailureMarkup(t)
    }
    node.innerHTML = inner
  }
  return doc.body.innerHTML
}
