// Plan 04 — copy fidelity (R13): turn the preview's bare semantic HTML into a Word /
// Confluence / Excel / Notion "what you see is what you get" payload.
//
// Strategy (D12 = A, recommended): inline a SELECTED subset of computed styles onto every
// element so the fragment renders correctly without the preview's external CSS (§4.2). Mermaid
// diagrams (D13) are rasterized to PNG `data:` URLs because the target apps don't render inline
// `<svg>`. Math (D17) is deliberately NOT rasterized: KaTeX emits MathML next to its HTML, and
// Word / OneNote turn that MathML into real editable equations (§4.8) — a bitmap would be a
// downgrade. Dark themes are forced to light (D16) so a dark preview never pastes as
// grey-on-grey. Excel/Word specific tweaks (§4.6) raise the hit rate further.
//
// Design note: instead of pairing live DOM ↔ clone (the fragile approach in the plan's early
// drafts), we attach the to-be-copied fragment to the document (offscreen) and read its OWN
// computed style — the fragment is self-describing, so no cross-tree pairing is needed and the
// canonical/live mismatch risk disappears entirely.
import lightCssRaw from 'github-markdown-css/github-markdown.css?raw'
import { stripInternalAttrs, getInlinedImageMap } from './previewCopy'
import { mermaidPngCache, mermaidSvgCache, slotHashMap } from './mermaidBake'

// R13.8 — hard ceiling on inlined-style volume, enforced on BOTH sides: an oversized INPUT skips
// the (expensive) style walk, and an oversized RESULT is discarded because inlining multiplies
// the markup — so the ceiling bounds the actual clipboard payload, not just the work. Either way
// the payload degrades to "structure only" (no inline styles) instead of stalling the copy.
const MAX_INLINE_BYTES = 1024 * 1024

// A1 — selected computed-style properties (§4.2). Layout properties that Word/Excel mangle
// (display/position/width/height/overflow/float) are deliberately excluded.
const SIMPLE_PROPS = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'color',
  'background-color',
  'padding',
  'margin',
  'text-align',
  'vertical-align',
  'text-decoration',
  'list-style-type',
  'list-style-position',
  'white-space',
  'border-collapse',
  'border-radius',
] as const

// Reused light stylesheet element for forceLight (D16) — injected once, moved between hosts.
let lightStyleEl: HTMLStyleElement | null = null

/**
 * The app's LIGHT design tokens (`:root` in globals.css) as a CSS declaration block. The host
 * re-declares them so a dark app theme cannot leak into the payload: globals.css declares every
 * token twice — on `:root` (light) and on `.dark`, which App.tsx toggles on <html> — so a host
 * nested in <body> inherits the DARK values while the app is dark, and any globals.css rule
 * matching inside the fragment (`.markdown-body pre` / `pre.hljs` background + border, …) would
 * inline dark colours into a payload that must be light (D16). Reading them from the CSSOM keeps
 * globals.css the single source of truth — no token value is duplicated here.
 */
export function lightTokenDeclarations(): string {
  const decls: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of readableRules(sheet)) {
      if (!(rule instanceof CSSStyleRule)) continue
      // `:root` may be written as a selector list (Tailwind emits `:root, :host`).
      if (!rule.selectorText.split(',').some((s) => s.trim() === ':root')) continue
      for (let i = 0; i < rule.style.length; i++) {
        const name = rule.style.item(i)
        if (name.startsWith('--')) decls.push(`${name}: ${rule.style.getPropertyValue(name)}`)
      }
    }
  }
  return decls.join('; ')
}

/** `cssRules` throws for a stylesheet we may not read — such a sheet contributes nothing. */
export function readableRules(sheet: CSSStyleSheet): CSSRule[] {
  try {
    return Array.from(sheet.cssRules)
  } catch {
    return []
  }
}

/**
 * Core entry: take the bare (un-stripped) copy HTML and return a finalized, Word-ready HTML
 * string. `forceLight` is always true per D16 — every paste is rendered on a light background;
 * `maxBytes` is the R13.8 ceiling (parameterized so a unit test can exercise the degrade path
 * without building megabyte fixtures).
 */
export function enhanceForPaste(
  html: string,
  forceLight = true,
  maxBytes = MAX_INLINE_BYTES,
): string {
  const work = parseFragment(html)
  // R13.8 — the ceiling is enforced on both the input (skip the expensive walk) and the result
  // (inlining multiplies the markup). It measures MARKUP, not embedded binary: a document that
  // merely carries inlined images is not "huge" (the walk's cost scales with node count, and the
  // base64 is unavoidable), and counting it would throw the styles away precisely on the
  // image-heavy documents where they matter most. A breach degrades to "structure only", but
  // rasterization and marker stripping still run, so diagrams survive even on gigantic documents.
  if (markupBytes(html) <= maxBytes) {
    walkAll(work, forceLight)
    if (markupBytes(work.innerHTML) <= maxBytes) return finalize(work)
  }
  return finalize(parseFragment(html))
}

function parseFragment(html: string): HTMLElement {
  const work = document.createElement('div')
  work.innerHTML = html
  return work
}

// An inlined binary (`data:…;base64,…`) collapses to a constant for the R13.8 accounting above.
const DATA_URL_BODY_RE = /data:[a-z0-9.+-]*\/[a-z0-9.+-]*;base64,[A-Za-z0-9+/=]+/gi

/** Length of `html` with inlined base64 bodies replaced by a placeholder (see enhanceForPaste). */
function markupBytes(html: string): number {
  return html.replace(DATA_URL_BODY_RE, 'data:,').length
}

// Attach the fragment to an offscreen host (light, see makeLightHost) and inline the selected
// computed styles. Split out of enhanceForPaste so the R13.8 volume guard can skip it wholesale.
function walkAll(work: HTMLElement, forceLight: boolean): void {
  const scoped = document.createElement('div')
  scoped.className = 'markdown-body'
  scoped.appendChild(work)

  const host = forceLight ? makeLightHost(scoped) : scoped
  document.body.appendChild(host)
  try {
    // Force a style flush so getComputedStyle resolves the attached fragment's real values.
    void host.offsetHeight
    for (const child of Array.from(scoped.children) as HTMLElement[]) {
      walkInline(child, scoped)
    }
  } finally {
    host.remove()
  }
}

/**
 * Copy-path entry that must NEVER throw. If the fidelity walk fails we still hand the `copy`
 * handler a payload (the clean semantic HTML with internal markers stripped) so it calls
 * preventDefault — otherwise the browser performs its native copy of the raw, un-styled DOM,
 * which pastes with no inline colors and unusable inline `<svg>` (the exact "worse than
 * nothing" failure mode we guard against, §4.5).
 */
export function safeEnhanceForPaste(html: string): string {
  try {
    return enhanceForPaste(html)
  } catch {
    return stripInternalAttrs(html)
  }
}

function makeLightHost(scoped: HTMLElement): HTMLElement {
  const host = document.createElement('div')
  host.setAttribute('data-copy-fidelity', '')
  // Offscreen but rendered (NOT display:none, which would zero out computed styles).
  host.style.cssText = 'position:absolute;left:-99999px;top:0;width:760px;visibility:hidden;'
  if (!lightStyleEl) {
    lightStyleEl = document.createElement('style')
    lightStyleEl.textContent = lightCssRaw
  }
  host.appendChild(lightStyleEl) // moves the singleton into this host
  // Pin the LIGHT token values on the host itself (see lightTokenDeclarations): without this the
  // dark app theme leaks into every token-based rule that matches inside the fragment.
  const tokens = lightTokenDeclarations()
  if (tokens) {
    const tokenStyle = document.createElement('style')
    tokenStyle.textContent = `[data-copy-fidelity]{${tokens}}`
    host.appendChild(tokenStyle)
  }
  host.appendChild(scoped)
  return host
}

// Walk the fragment, inlining selected computed styles. Skips the mermaid slot and KaTeX
// subtrees entirely: each carries its own rendering (a rasterized PNG for mermaid, MathML for
// math) that must not be flattened into inline styles.
function walkInline(node: HTMLElement, parent: HTMLElement): void {
  // Skip mermaid + KaTeX subtrees: the slot is replaced later (replaceMermaid) and the formula
  // must keep its MathML intact (§4.8).
  if (node.hasAttribute('data-mermaid-slot') || node.classList.contains('katex')) return
  const decl = collectInlineStyles(node, parent)
  if (decl) node.setAttribute('style', decl)
  for (const child of Array.from(node.children) as HTMLElement[]) {
    walkInline(child, node)
  }
}

// Every walked node has a parent (the wrapper `scoped` div for top-level children), so the
// parent is required — no null branch to keep unreachable.
function collectInlineStyles(el: HTMLElement, parent: HTMLElement): string {
  const cs = getComputedStyle(el)
  const pcs = getComputedStyle(parent)
  const decls: string[] = []
  for (const prop of SIMPLE_PROPS) {
    const v = cs.getPropertyValue(prop)
    if (!v) continue
    // Skip values inherited unchanged from the parent (keeps the payload small, §4.2.3).
    // Normalize first: getComputedStyle returns inconsistently-spaced values across engines
    // (e.g. `rgb(0,0,0)` vs `rgb(0, 0, 0)`), so compare normalized forms.
    const cv = norm(v)
    const pv = norm(pcs.getPropertyValue(prop))
    if (pv === cv) continue
    if (isTransparent(cv)) continue
    decls.push(`${prop}: ${v}`)
  }
  decls.push(...collectBorders(cs))
  return decls.join('; ')
}

/** Collapse whitespace so computed-style comparisons are engine-agnostic. */
function norm(v: string): string {
  return v
    .replace(/\s+/g, ' ')
    .replace(/\s*([:,;])\s*/g, '$1')
    .trim()
}

function isTransparent(v: string): boolean {
  return v === 'transparent' || /^rgba?\(0,\s*0,\s*0,\s*0\)$/.test(v.trim())
}

function collectBorders(cs: CSSStyleDeclaration): string[] {
  const sides = ['top', 'right', 'bottom', 'left'] as const
  const parts = sides.map((s) => ({
    w: cs.getPropertyValue(`border-${s}-width`),
    st: cs.getPropertyValue(`border-${s}-style`),
    c: cs.getPropertyValue(`border-${s}-color`),
  }))
  const decls: string[] = []
  const visible = (i: number) =>
    parts[i].w && parts[i].w !== '0px' && parts[i].st && parts[i].st !== 'none'
  const uniform = sides.every(
    (_, i) => parts[i].w === parts[0].w && parts[i].st === parts[0].st && parts[i].c === parts[0].c,
  )
  if (uniform) {
    if (visible(0)) decls.push(`border: ${parts[0].w} ${parts[0].st} ${parts[0].c}`)
  } else {
    sides.forEach((s, i) => {
      if (visible(i)) decls.push(`border-${s}: ${parts[i].w} ${parts[i].st} ${parts[i].c}`)
    })
  }
  return decls
}

// R13.1 / D13 — replace each mermaid slot with a cached PNG `<img>` (Word-safe). Slots whose
// PNG isn't cached yet keep their inline `<svg>` so content is never lost (keyboard path before
// the bake completes). The cache is filled by mermaidBake on every render (D14).
function replaceMermaid(work: HTMLElement): void {
  const slotMap = slotHashMap()
  const slots = Array.from(work.querySelectorAll('[data-mermaid-slot]'))
  for (const slot of slots) {
    const n = Number(slot.getAttribute('data-mermaid-slot'))
    const hash = slotMap.get(n)
    const png = hash ? mermaidPngCache.get(hash) : undefined
    if (png) {
      const img = document.createElement('img')
      img.src = png.dataUrl
      img.alt = 'diagram'
      // Pin the DISPLAY size to the diagram's CSS size: the bitmap is 2× that (crisp), and without
      // these attributes the target app renders it at the raw pixel size — 2× too big (D13).
      img.setAttribute('width', String(Math.round(png.width)))
      img.setAttribute('height', String(Math.round(png.height)))
      slot.replaceWith(img)
      continue
    }
    // No PNG yet (rasterization is async, or unavailable): NEVER leave the slot empty. A live-DOM
    // source (keyboard copy / partial selection) carries unfilled placeholders because the preview
    // bakes lazily — backfill the diagram from the SVG cache. Losing the diagram is worse than a
    // vector the target may not render.
    if (hash && !slot.querySelector('svg')) {
      const cached = mermaidSvgCache.get(hash)
      if (cached) slot.innerHTML = cached.svg
    }
  }
}

// §4.8 — rewrite appdoc:// images from the pre-inlined map so the SYNCHRONOUS keyboard path also
// embeds the images of a PARTIAL SELECTION (the whole-article cache only covers the full
// document, and the menu path inlines via embedImages instead). Unmapped sources are left
// untouched: showing a broken image beats embedding the WRONG one, and the copy never fails.
function inlineCachedImages(work: HTMLElement): void {
  const map = getInlinedImageMap()
  if (map.size === 0) return
  work.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src')
    const dataUrl = src ? map.get(src) : undefined
    if (dataUrl) img.setAttribute('src', dataUrl)
  })
}

// §4.6 — per-target tweaks that raise the paste hit rate (Excel real tables, etc.).
function postProcess(work: HTMLElement): void {
  const cells = work.querySelectorAll('td, th')
  cells.forEach((cell) => {
    // Old Excel reads the `border` attribute; new Excel reads inline `border` (both are written).
    cell.setAttribute('border', '1')
    const bg = (cell as HTMLElement).style.backgroundColor
    if (bg && !isTransparent(bg)) cell.setAttribute('bgcolor', rgbToHex(bg))
  })
  work.querySelectorAll('table').forEach((t) => t.setAttribute('border', '1'))
}

// Minimal document envelope improves Word / Outlook HTML parsing stability (§4.6).
function wrapHtml(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body class="markdown-body">${body}</body></html>`
}

function finalize(work: HTMLElement): string {
  replaceMermaid(work)
  inlineCachedImages(work)
  postProcess(work)
  return wrapHtml(stripInternalAttrs(work.innerHTML))
}

function rgbToHex(v: string): string {
  const m = v.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i)
  if (!m) return v
  const toHex = (n: string) => Number(n).toString(16).padStart(2, '0')
  return `#${toHex(m[1]!)}${toHex(m[2]!)}${toHex(m[3]!)}`
}

/** Exported for unit coverage of the rgb→hex branch. */
export { rgbToHex }
