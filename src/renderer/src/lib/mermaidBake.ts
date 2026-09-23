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
import { rasterizeSvg, type SvgSize } from './rasterize'
import type { MermaidSlot } from './markdownPipeline'
import { getExportMermaidSlots } from './exportStore'
import type { TranslationKey } from '../../../../shared/i18n/en'

// plan-04 §4.3 — the diagram caches are content-keyed, so they never need invalidation on doc or
// theme switches (same source ⇒ same artifact, and D16 already forces a light, white-background
// rasterization). They are FIFO-capped instead: a long session over many documents would
// otherwise hold every SVG string and base64 PNG (~tens to hundreds of KB each) for the lifetime
// of the window. A cap can only cost a re-render — never a wrong diagram.
const MAX_CACHED_DIAGRAMS = 200

/** Drop the oldest entries until `map` holds at most `max` (deleting during iteration is safe). */
export function evictOldest<K, V>(map: Map<K, V>, max: number): void {
  for (const key of map.keys()) {
    if (map.size <= max) return
    map.delete(key)
  }
}

// D14 — PNG rasterization cache, keyed by mermaid content hash. Filled on every render (lazy
// preview + complete bake) so the synchronous copy path can swap a diagram for a Word-safe
// `<img data:png>` without awaiting rasterization.
//
// The entry carries the diagram's CSS size next to the bitmap: the copy payload writes it onto the
// `<img>` as width/height so the target app displays the 2× bitmap at the size the preview shows.
export interface MermaidPngEntry extends SvgSize {
  dataUrl: string
}
export const mermaidPngCache = new Map<string, MermaidPngEntry>()

// In-flight rasterizations, keyed by hash, so two triggers of the same diagram (e.g. the lazy
// preview render AND the complete bake) collapse into ONE canvas rasterization instead of racing.
const pngInflight = new Map<string, Promise<void>>()

/**
 * Await a diagram's PNG form being in `mermaidPngCache`. Idempotent (already cached → resolves
 * immediately) and de-duped per hash (concurrent callers share one rasterization). This is the
 * awaitable core the bake uses so the SYNCHRONOUS `copy` event always finds a warm cache — the
 * fix for "the first copy drops diagrams" (rasterization is async, the copy event is not).
 */
export function ensureMermaidPng(hash: string, svg: string): Promise<void> {
  if (mermaidPngCache.has(hash)) return Promise.resolve()
  const pending = pngInflight.get(hash)
  if (pending) return pending
  // Deliberately NOT behind `v8 ignore`: this chain is reachable under unit tests (the suite
  // mocks `./rasterize`), and ADR 0004 / CONTRIBUTING allow an ignore only for a block that can
  // neither be reached by tests nor be deleted. Masking it would hide real regressions.
  const p = rasterizeSvg(svg, { background: '#ffffff' })
    .then((entry) => {
      mermaidPngCache.set(hash, entry)
      evictOldest(mermaidPngCache, MAX_CACHED_DIAGRAMS)
    })
    .catch(() => {})
    .finally(() => {
      pngInflight.delete(hash)
    })
  pngInflight.set(hash, p)
  return p
}

/**
 * Rasterize every listed diagram's PNG form into `mermaidPngCache`. Cache-first: a diagram that
 * already has a PNG (or whose SVG was never rendered) is skipped. Runs after the SVG bake, which
 * guarantees every slot's source SVG is in `mermaidSvgCache`.
 */
export async function ensureAllMermaidPngs(slots: MermaidSlot[]): Promise<void> {
  await Promise.all(
    slots.map((s) => {
      const cached = mermaidSvgCache.get(s.hash)
      return cached ? ensureMermaidPng(s.hash, cached.svg) : Promise.resolve()
    }),
  )
}

/**
 * slot index → content hash for the current document (ADR 0019: the diagram SOURCES live in
 * exportStore next to the HTML, because the string alone carries only placeholders). Shared by
 * every consumer that has to resolve a `data-mermaid-slot="N"` marker back to a diagram.
 */
export function slotHashMap(): Map<number, string> {
  const map = new Map<number, string>()
  for (const s of getExportMermaidSlots()) map.set(s.slot, s.hash)
  return map
}

/**
 * True iff `html` carries a diagram slot whose PNG is not in the cache yet — writing it out now
 * would ship a degraded (or empty) diagram. The synchronous `copy` handler uses this to decide
 * whether the copy must be deferred. The check is deliberately on the PAYLOAD and not on "is the
 * bake complete", so a copy that carries no diagram at all (a paragraph, a table) is never delayed
 * behind a whole-document rasterization.
 */
export function hasUnresolvedDiagram(html: string): boolean {
  const slotMap = slotHashMap()
  for (const m of html.matchAll(/data-mermaid-slot="(\d+)"/g)) {
    const hash = slotMap.get(Number(m[1]))
    if (hash && !mermaidPngCache.has(hash)) return true
  }
  return false
}

/** Fire-and-forget PNG cache warm (D14). The render paths don't need to await it. */
export function cacheMermaidPng(hash: string, svg: string): void {
  void ensureMermaidPng(hash, svg)
}

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
  evictOldest(mermaidSvgCache, MAX_CACHED_DIAGRAMS)
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
    cacheMermaidPng(info.hash, cached.svg)
    return
  }
  try {
    const entry = await bakeMermaidSlot(info)
    fillMermaidSlot(el, entry)
    cacheMermaidPng(info.hash, entry.svg)
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
      const entry = await bakeMermaidSlot(info)
      inner = entry.svg
      cacheMermaidPng(info.hash, inner)
    } catch {
      inner = mermaidFailureMarkup(t)
    }
    node.innerHTML = inner
  }
  return doc.body.innerHTML
}
