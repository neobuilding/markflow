// Vite build plugin: drop the redundant KaTeX font formats (.ttf/.woff/.eot/.otf)
// from the renderer bundle.
//
// KaTeX ships every glyph in three formats; modern Electron/Chromium only ever uses
// `.woff2`, because KaTeX's `@font-face` lists the woff2 source FIRST (verified in the
// built `dist/renderer/assets/vendor-katex-*.css`). Removing the others from the
// `generateBundle` bundle means they are never written to disk at all — no
// write-then-delete, and it runs for ANY `vite build` (CI, direct invocation), not
// just when invoked through the npm script.
//
// Conservative by design: a family with no `.woff2` asset (e.g. `KaTeX_Size3-Regular`,
// whose woff2 is inlined into the CSS as a `data:` URI) keeps its fallback formats, so
// no glyph can ever break.
import { extname, basename } from 'node:path'
import type { Plugin } from 'vite'

const FONT_EXTS = ['.woff2', '.woff', '.ttf', '.eot', '.otf']
const REDUNDANT = new Set(['.ttf', '.woff', '.eot', '.otf'])

// Recover the font family (original base name) from a built asset file name.
// Vite's default asset naming appends `-<hash>` (8 base64url chars, which may include
// `-`/`_`) before the extension; the family is everything before that hash and is
// shared by all three formats of the same glyph.
//
// ONLY an exact 8-char hash is stripped — there is deliberately no looser fallback.
// A shorter/looser suffix match would eat the font's own STYLE suffix
// (`KaTeX_Main-Regular` -> `KaTeX_Main`), merging different styles of the same font
// into one family; a Bold `.woff2` would then delete Regular's `.ttf`/`.woff` and
// break those glyphs. When a file carries no hash (e.g. a custom `assetFileNames`)
// it simply becomes its own one-member family, which degrades to "never prune" —
// the safe direction.
export function fontFamilyOf(fileName: string): string {
  const base = basename(fileName).replace(/\.(woff2|woff|ttf|eot|otf)$/i, '')
  return base.replace(/-[A-Za-z0-9_-]{8}$/, '')
}

// Remove redundant font assets from a Rollup output bundle (mutates it) and return
// the removed file names. Exported for unit testing.
export function pruneRedundantFontAssets(bundle: Record<string, unknown>): string[] {
  const families = new Map<string, { hasWoff2: boolean; redundant: string[] }>()
  for (const fileName of Object.keys(bundle)) {
    const ext = extname(fileName).toLowerCase()
    if (!FONT_EXTS.includes(ext)) continue
    const family = fontFamilyOf(fileName)
    const bucket = families.get(family) ?? { hasWoff2: false, redundant: [] }
    if (ext === '.woff2') bucket.hasWoff2 = true
    else if (REDUNDANT.has(ext)) bucket.redundant.push(fileName)
    families.set(family, bucket)
  }

  const removed: string[] = []
  for (const bucket of families.values()) {
    if (!bucket.hasWoff2) continue
    for (const fileName of bucket.redundant) {
      delete bundle[fileName]
      removed.push(fileName)
    }
  }
  return removed
}

// Vite plugin that prunes the redundant KaTeX fallback fonts from the renderer bundle.
export function pruneKaTeXFallbacks(): Plugin {
  return {
    name: 'markflow:prune-katex-fallbacks',
    apply: 'build',
    generateBundle(_options, bundle) {
      const removed = pruneRedundantFontAssets(bundle)
      if (removed.length > 0) {
        this.info(`pruned ${removed.length} redundant font file(s); kept .woff2 only`)
      }
    },
  }
}
