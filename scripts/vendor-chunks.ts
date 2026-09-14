// Vendor chunk-splitting policy for the renderer build (consumed by vite.config.ts).
//
// Third-party libraries are isolated into their own chunks so that:
//   - the app-code chunk stays small and cache invalidation is granular, and
//   - each vendor can be cached independently.
//
// A few libraries that ship as a family are grouped into ONE chunk (mermaid,
// katex/mathjax, the CodeMirror + lezer editor stack, the radix-ui + tanstack UI
// stack, and d3) because their sub-packages change and cache together. A handful
// of heavy single packages get explicit, stable chunk names. EVERY other
// node_modules package gets its OWN `vendor-<pkg>` chunk (name sanitized to be
// filesystem-safe). This guarantees the catch-all never aggregates enough modules
// to exceed `chunkSizeWarningLimit` (3000 kB), so the build stays warning-free —
// and new dependencies are handled automatically without revisiting this file.
//
// Chunk NAMES do not affect eager vs lazy loading; Rollup decides that from the
// import graph. So isolating a package here never changes runtime load semantics
// (e.g. mermaid is still lazy, react is still eager).
//
// ONLY SCRIPT modules take part in this policy.
//
// This is not cosmetics: `main.tsx` statically imports `katex/dist/katex.min.css` and
// `highlight.js/styles/github.css`, and `export.ts` imports the katex CSS with `?raw`.
// Those ids contain the "katex" / "highlight.js" substrings, so matching them here
// merged the statically-imported CSS module into the SAME chunk as the 546 kB katex and
// 921 kB highlight.js libraries. That put both chunks back into the renderer's static
// import graph, so Vite emitted them as `modulepreload` links in index.html and they
// were downloaded on first paint even though only the parse Worker needs them.
// Stylesheets (and any other non-script module) must fall through to Vite's default so
// they can never drag a library into the eager graph.
export function vendorChunkFor(id: string): string | undefined {
  // Drop Vite's query suffixes (?raw, ?url, ?inline, ?used) before checking the type.
  const path = id.split('?', 1)[0]
  if (!/\.(?:[cm]?jsx?|tsx?)$/i.test(path)) return undefined
  if (!id.includes('node_modules')) return undefined
  if (id.includes('mermaid')) return 'vendor-mermaid'
  if (id.includes('katex') || id.includes('mathjax')) return 'vendor-katex'
  if (id.includes('codemirror') || id.includes('@lezer')) return 'vendor-editor'
  if (id.includes('@radix-ui') || id.includes('@tanstack')) return 'vendor-ui'
  if (id.includes('node_modules/d3')) return 'vendor-d3'
  // Heavy single packages: explicit, stable chunk names.
  if (id.includes('node_modules/highlight.js')) return 'vendor-highlight'
  if (id.includes('node_modules/dagre-d3-es')) return 'vendor-dagre'
  if (id.includes('node_modules/chevrotain')) return 'vendor-chevrotain'
  if (id.includes('node_modules/@chevrotain')) return 'vendor-chevrotain'
  if (id.includes('node_modules/lodash-es')) return 'vendor-lodash'
  if (id.includes('node_modules/lucide-react')) return 'vendor-lucide'
  if (id.includes('node_modules/khroma')) return 'vendor-khroma'
  if (id.includes('node_modules/es-toolkit')) return 'vendor-es-toolkit'
  // Everything else: one chunk per package (sanitized so scoped/dotted names are
  // filesystem-safe, e.g. `@chevrotain/regexp-to-ast` -> `vendor--chevrotain-regexp-to-ast`).
  const m = id.match(/[\\/]node_modules[\\/](@[^\\/]+[\\/][^\\/]+|[^\\/]+)/)
  if (m) return `vendor-${m[1].replace(/[^a-zA-Z0-9]+/g, '-')}`
  return 'vendor'
}
