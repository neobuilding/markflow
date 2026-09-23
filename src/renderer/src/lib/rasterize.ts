// Rasterize an SVG string to a PNG `data:` URL so it can be copied as a bitmap via
// `clipboard:write-image` (§4.4) or embedded into a rich-text copy payload as an `<img>`
// (plan 04 D13). Runs entirely on the renderer using an offscreen <img> + <canvas>.
//
// Extracted from previewCopy.ts so both the copy pipeline and the mermaid bake can share it
// without creating an import cycle (mermaidBake ⇄ copyFidelity ⇄ previewCopy).

// The <img> source for rasterization. MUST be a `data:` URL, NOT a `blob:` object URL: the
// app's CSP restricts `img-src` to `'self' data: https: appdoc:` (electron/main/lib/csp.ts), and
// a `blob:` src is blocked — which made every rasterization fail silently, so mermaid diagrams
// and KaTeX formulas were never turned into PNG and pasted as unusable inline `<svg>` instead.
// Kept OUTSIDE the v8-ignore block below (it is pure and unit-tested).
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** An SVG's intrinsic size in CSS px. */
export interface SvgSize {
  width: number
  height: number
}

/**
 * Rasterization scale for the copy payload (D13). 2× is the standard retina multiplier: crisp on
 * normal and high-DPI screens, while keeping each diagram's byte cost sane. It was briefly raised
 * to 3× to fight blur, but the blur came from a wrong base size (F22 / `svgIntrinsicSize`), not
 * from the multiplier — once the base size was correct, 3× only added ~2.25× the bytes for no
 * visible gain, which is what makes target apps (Youdao / WeChat) drop later images on a paste
 * budget. The display size is pinned via the payload `<img>`'s width/height, so 2× stays sharp
 * even when the target re-scales the bitmap.
 */
export const RASTER_SCALE = 2

/**
 * Hard ceiling on the bitmap's long edge, so one giant diagram (e.g. a 2560px-wide gantt that would
 * balloon to 5120px at 2×) cannot blow the payload up — 2000px is the comfortable upper bound for
 * the rich-text targets we paste into (R13.8).
 */
const MAX_RASTER_EDGE = 2000

/**
 * The SVG's INTRINSIC CSS size, read from the MARKUP only.
 *
 * Never use `HTMLImageElement.naturalWidth/Height` for this: mermaid emits `width="100%"` with a
 * `viewBox`, and such an image has no intrinsic width — the browser reports its 300×150 default
 * (measured: 55×150 for the demo's first diagram, which is shown on screen at 181×499). That is
 * exactly how a 110×300 bitmap ended up standing in for an 181×499 diagram: blurry AND small.
 *
 * Absolute `width`/`height` attributes win (hand-authored vector art); otherwise the viewBox.
 */
export function svgIntrinsicSize(svg: string): SvgSize | null {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const el = doc.documentElement
  const aw = absoluteLength(el.getAttribute('width'))
  const ah = absoluteLength(el.getAttribute('height'))
  if (aw && ah) return { width: aw, height: ah }
  const vb = el
    .getAttribute('viewBox')
    ?.split(/[\s,]+/)
    .map(Number)
  const w = vb?.[2] ?? 0
  const h = vb?.[3] ?? 0
  if (w > 0 && h > 0) return { width: w, height: h }
  return null
}

/** Parse an absolute CSS length (px/pt/in/…); `null` for percentages, missing or non-positive. */
function absoluteLength(v: string | null): number | null {
  if (!v || v.endsWith('%')) return null
  const n = parseFloat(v)
  return n > 0 ? n : null
}

/**
 * Pixel size of the bitmap to produce: the CSS size scaled by `scale`, capped on the long edge and
 * never below 1×1. Pure (unit-tested) — the canvas work lives in `rasterizeSvg` below.
 */
export function rasterPixelSize(size: SvgSize, scale: number = RASTER_SCALE): SvgSize {
  const fit = Math.min(scale, MAX_RASTER_EDGE / Math.max(size.width, size.height))
  return {
    width: Math.max(1, Math.round(size.width * fit)),
    height: Math.max(1, Math.round(size.height * fit)),
  }
}

/** A rasterized SVG: the PNG plus the CSS size the target app should DISPLAY it at. */
export interface RasterizedSvg extends SvgSize {
  dataUrl: string
}

/* v8 ignore start: rasterizeSvg drives a real <img>/<canvas> pipeline that jsdom cannot execute
   (no Image.onload, no 2d context, no toDataURL). Both paths are exercised by the e2e suite
   (context-menu.e2e.spec.ts / select-all-copy-fidelity.e2e.spec.ts) in a real browser, so they are
   held out of unit line/branch coverage. */
/**
 * Rasterize `svg` at `scale` (default `RASTER_SCALE`, 2×) on an optional opaque background.
 *
 * `dataUrl` is the bitmap; `width`/`height` are the SVG's CSS size, which the caller MUST put on the
 * payload `<img>` — without them the target app renders the bitmap at its raw pixel size (2× the
 * intended size on a normal display, 1× too big).
 */
export async function rasterizeSvg(
  svg: string,
  opts?: { background?: string; scale?: number },
): Promise<RasterizedSvg> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const size = svgIntrinsicSize(svg) ?? naturalSize(img)
      const px = rasterPixelSize(size, opts?.scale)
      const canvas = document.createElement('canvas')
      canvas.width = px.width
      canvas.height = px.height
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('no 2d context'))
        return
      }
      // Optional opaque background (D13/D16: mermaid is rasterized on white so a dark-themed
      // preview still pastes as a legible light diagram).
      if (opts?.background) {
        ctx.fillStyle = opts.background
        ctx.fillRect(0, 0, canvas.width, canvas.height)
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve({ dataUrl: canvas.toDataURL('image/png'), ...size })
    }
    img.onerror = () => reject(new Error('svg rasterization failed'))
    img.src = svgDataUrl(svg)
  })
}

/** Bitmap-only view of `rasterizeSvg` (the context menu's "Copy Image" needs just the PNG). */
export async function svgToPngDataUrl(
  svg: string,
  opts?: { background?: string; scale?: number },
): Promise<string> {
  return (await rasterizeSvg(svg, opts)).dataUrl
}

/** Fallback for an SVG with neither absolute dimensions nor a viewBox. */
function naturalSize(img: HTMLImageElement): SvgSize {
  if (img.naturalWidth > 0 && img.naturalHeight > 0) {
    return { width: img.naturalWidth, height: img.naturalHeight }
  }
  return { width: 800, height: 600 }
}
/* v8 ignore stop */
