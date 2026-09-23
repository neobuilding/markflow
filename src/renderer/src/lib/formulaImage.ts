// Rasterize a KaTeX formula from the live preview into a PNG — the "Copy formula as image"
// right-click item (ADR 0020).
//
// Why this exists at all: rich-text copy keeps a formula's **MathML** as its carrier (§4.8) because
// Word / OneNote turn MathML into a real, editable equation — a bitmap would be a downgrade. But
// targets that understand neither MathML nor KaTeX's CSS (Youdao Note, F23) show the formula as
// three concatenated texts. One clipboard cannot distinguish targets, so the bitmap is an explicit,
// per-formula user action instead of a silent downgrade of every copy.
//
// Mechanism (F17): serialize the rendered `.katex` subtree into an SVG `<foreignObject>` with
// KaTeX's CSS and its woff2 fonts inlined as `data:` URLs, then rasterize it through the same
// pipeline mermaid uses (`rasterize.ts`). Two constraints make the details non-obvious:
//   • An SVG loaded through `<img>` renders in "secure static mode": NO external resource is
//     fetched, so the fonts must be inlined (the CSP allows `data:` fonts — `font-src 'self' data:`).
//   • The subtree must be serialized as XML (`XMLSerializer`), not with `outerHTML`. `outerHTML`
//     emits HTML void elements (`<br>`) and no XHTML namespace, and an SVG that fails to parse
//     fails SILENTLY in `<img>` — the same class of bug as the `blob:` CSP one (F14).

import katexCssRaw from 'katex/dist/katex.min.css?raw'
import { svgToPngDataUrl } from './rasterize'

/** Breathing room around the glyphs, so a pasted bitmap never looks cropped. */
export const FORMULA_PADDING = 8

/**
 * Rasterization scale — 2×, matching the payload scale (`RASTER_SCALE`). A clipboard bitmap carries
 * no display-size metadata: the target app shows it at its pixel size, so a higher multiplier would
 * make every pasted formula larger than intended (and inflate the payload).
 */
export const FORMULA_SCALE = 2

/** The bitmap is always opaque white with black glyphs: a dark theme must not paste white-on-white. */
const BACKGROUND = '#ffffff'
const TEXT_COLOR = '#000000'
const XHTML_NS = 'http://www.w3.org/1999/xhtml'
const KATEX_FONT_PREFIX = 'KaTeX_'
/** `CSSRule.FONT_FACE_RULE` — named as a constant because jsdom exposes no `CSSRule` constants. */
const FONT_FACE_RULE = 5
const DEFAULT_FONT_SIZE = '16px'

/** Input to `buildFormulaSvg`: the serialized formula plus the size it occupies on screen. */
export interface FormulaSvgInput {
  /** XML-serialized `.katex` subtree, with the MathML branch removed. */
  html: string
  /** The formula's on-screen CSS size, WITHOUT padding. */
  width: number
  height: number
  /** `@font-face` rules with `data:` sources — without them the SVG falls back to other glyphs. */
  fontCss?: string
  padding?: number
}

/**
 * Drop the `@font-face` blocks from a stylesheet: their `url(fonts/…)` cannot load inside an
 * SVG-as-image (secure static mode), and they are replaced by `data:`-inlined faces.
 */
export function stripFontFaces(css: string): string {
  return css.replace(/@font-face\s*\{[^}]*\}/g, '')
}

/**
 * Wrap the serialized formula in a self-contained SVG sized `size + 2 × padding`.
 *
 * The wrapper div carries the XHTML namespace (required: without it the children are not in the
 * XHTML namespace and nothing renders), the opaque background and the text colour.
 */
export function buildFormulaSvg(input: FormulaSvgInput): string {
  const padding = input.padding ?? FORMULA_PADDING
  const width = Math.ceil(input.width + padding * 2)
  const height = Math.ceil(input.height + padding * 2)
  const style = `${stripFontFaces(katexCssRaw)}\n${input.fontCss ?? ''}`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    `<style>${style}</style>` +
    `<foreignObject x="0" y="0" width="${width}" height="${height}">` +
    `<div xmlns="${XHTML_NS}" style="width:${width}px;height:${height}px;padding:${padding}px;` +
    `box-sizing:border-box;background:${BACKGROUND};color:${TEXT_COLOR};` +
    `display:flex;align-items:center;justify-content:center">${input.html}</div>` +
    `</foreignObject></svg>`
  )
}

interface FontFaceSpec {
  cssText: string
  url: string
}

let fontCssCache = ''

/**
 * Forget the cached font CSS (a test seam, and correct after a stylesheet/font reload).
 * Without it a unit test cannot observe the fetch path twice.
 */
export function resetKatexFontCache(): void {
  fontCssCache = ''
}

/**
 * KaTeX's `@font-face` rules with their woff2 payloads inlined as `data:` URLs.
 *
 * Every face whose family starts with `KaTeX_` is inlined (9 families / 20 files, ~254 kB before
 * base64, fetched once and cached). Inlining only the families a formula happens to use would be
 * cheaper but needs the computed `font-family` of every descendant to survive the SVG boundary —
 * fragile, and a miss silently degrades the glyphs. This is what `html-to-image` does too.
 */
export async function katexFontFaceCss(): Promise<string> {
  if (fontCssCache) return fontCssCache
  const specs = collectKatexFontFaces()
  const rules = await Promise.all(specs.map(inlineFontFace))
  const css = rules.filter((rule): rule is string => rule !== null).join('\n')
  // Only a non-empty result is cached, so one transient fetch failure cannot poison the session.
  if (css) fontCssCache = css
  return css
}

function collectKatexFontFaces(): FontFaceSpec[] {
  const specs: FontFaceSpec[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRule[]
    try {
      rules = Array.from(sheet.cssRules)
    } catch {
      // A cross-origin sheet throws on `cssRules`; nothing we can inline from it.
      continue
    }
    // A linked stylesheet's `url(…)` is relative to the STYLESHEET, not to the document: Vite
    // emits the hashed fonts next to the CSS in `assets/`, so resolving against `location.href`
    // pointed at a file that does not exist in the packaged build (`fetch` failed there, and the
    // formula silently came out in fallback glyphs). Inline `<style>` sheets have no `href` and
    // inherit the document base.
    const base = sheet.href ?? location.href
    for (const rule of rules) {
      if (rule.type !== FONT_FACE_RULE) continue
      const face = rule as CSSFontFaceRule
      if (!face.style.getPropertyValue('font-family').startsWith(KATEX_FONT_PREFIX)) continue
      const src = /url\(["']?([^"')]+)["']?\)/.exec(face.cssText)?.[1] ?? ''
      if (!src) continue
      specs.push({ cssText: face.cssText, url: new URL(src, base).href })
    }
  }
  return specs
}

/** Rewrite one `@font-face` rule so its `src` is the fetched woff2 as a `data:` URL. */
async function inlineFontFace(spec: FontFaceSpec): Promise<string | null> {
  const data = await fontDataUrl(spec.url)
  if (!data) return null
  return spec.cssText.replace(/src:[^;}]*/, `src:url("${data}") format("woff2")`)
}

async function fontDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.length === 0) return null
    return `data:font/woff2;base64,${bytesToBase64(bytes)}`
  } catch {
    return null
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/**
 * The font size to pin on the rasterized copy: KaTeX sizes everything in `em`, so the bitmap has
 * to be rendered at the size the formula actually had on screen (`1.05em` of the preview text,
 * per `globals.css`) — otherwise the glyphs come out ~15 % off the measured box.
 */
export function fontSizeOf(el: Element): string {
  return getComputedStyle(el).fontSize || DEFAULT_FONT_SIZE
}

/**
 * The on-screen box of a formula is NOT always its content box. A block-level `.katex` inside
 * `.katex-display` is `display:block` and spans the whole preview width with the glyphs centred,
 * so `getBoundingClientRect()` reports a full-width rectangle — rasterizing that paints the
 * formula in the middle of a huge white slab (reported in the field). Re-flow the node once in an
 * inline-block wrapper off-screen to obtain the TIGHT content bounds, which is what the bitmap
 * should be. The same wrapper shrinks an inline formula to its content as well, so one path fits
 * both.
 */
export function measureTightBox(el: HTMLElement): { width: number; height: number } {
  const fontSize = fontSizeOf(el)
  const clone = el.cloneNode(true) as HTMLElement
  clone.style.fontSize = fontSize
  const measure = document.createElement('div')
  measure.style.cssText =
    'position:absolute;left:-100000px;top:0;display:inline-block;white-space:nowrap;'
  measure.appendChild(clone)
  document.body.appendChild(measure)
  const rect = measure.getBoundingClientRect()
  document.body.removeChild(measure)
  return { width: rect.width, height: rect.height }
}

/**
 * Rasterize one rendered `.katex` element to a PNG `data:` URL, or `null` when it cannot be
 * rasterized (zero-sized, unreadable fonts, `<img>` rejected the SVG). Never throws: the menu
 * treats a failure as "nothing was copied", like every other silent copy path here.
 */
export async function formulaToPng(el: HTMLElement): Promise<string | null> {
  try {
    const { width, height } = measureTightBox(el)
    if (width <= 0 || height <= 0) return null
    const clone = el.cloneNode(true) as HTMLElement
    // The MathML branch is the carrier for rich-text copy; in a bitmap it would render as text.
    clone.querySelector('.katex-mathml')?.remove()
    clone.style.fontSize = fontSizeOf(el)
    const svg = buildFormulaSvg({
      html: new XMLSerializer().serializeToString(clone),
      width,
      height,
      fontCss: await katexFontFaceCss(),
    })
    return await svgToPngDataUrl(svg, { background: BACKGROUND, scale: FORMULA_SCALE })
  } catch {
    return null
  }
}
