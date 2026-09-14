import { describe, it, expect } from 'vitest'
import { vendorChunkFor } from './vendor-chunks.ts'

describe('vendorChunkFor — renderer vendor chunk policy', () => {
  it('keeps app source in the entry (undefined → Rollup default chunking)', () => {
    expect(vendorChunkFor('/src/renderer/src/App.tsx')).toBeUndefined()
    expect(vendorChunkFor('C:\\markflow\\src\\lib\\parse.ts')).toBeUndefined()
  })

  it('does not split a non-node_modules path that merely contains "d3"', () => {
    expect(vendorChunkFor('/src/lib/foo-d3-bar.ts')).toBeUndefined()
  })

  it('routes mermaid to its own chunk', () => {
    expect(vendorChunkFor('/node_modules/mermaid/dist/mermaid.esm.js')).toBe('vendor-mermaid')
  })

  it('routes katex / mathjax to vendor-katex', () => {
    expect(vendorChunkFor('/node_modules/katex/dist/katex.js')).toBe('vendor-katex')
    expect(vendorChunkFor('/node_modules/mathjax-full/es5/a.js')).toBe('vendor-katex')
  })

  it('routes CodeMirror / lezer to vendor-editor', () => {
    expect(vendorChunkFor('/node_modules/@codemirror/state/dist/index.js')).toBe('vendor-editor')
    expect(vendorChunkFor('/node_modules/@lezer/common/dist/index.js')).toBe('vendor-editor')
  })

  it('routes radix-ui / tanstack to vendor-ui', () => {
    expect(vendorChunkFor('/node_modules/@radix-ui/react-dialog/dist/index.js')).toBe('vendor-ui')
    expect(vendorChunkFor('/node_modules/@tanstack/react-query/dist/index.js')).toBe('vendor-ui')
  })

  // REGRESSION: stylesheets must NOT be grouped with the library whose path they
  // share. `main.tsx` imports katex/highlight.js CSS statically and `export.ts` imports
  // the katex CSS with `?raw`; grouping them merged the CSS module into the same chunk
  // as the 546 kB / 921 kB libraries, which put BOTH back into the renderer's static
  // import graph and made Vite `modulepreload` them on first paint.
  it('leaves stylesheets (and ?raw CSS) to Vite default so they cannot drag a library in', () => {
    expect(vendorChunkFor('/node_modules/katex/dist/katex.min.css')).toBeUndefined()
    expect(vendorChunkFor('/node_modules/katex/dist/katex.min.css?raw')).toBeUndefined()
    expect(vendorChunkFor('/node_modules/highlight.js/styles/github.css')).toBeUndefined()
    expect(vendorChunkFor('/node_modules/mermaid/dist/mermaid.css')).toBeUndefined()
    // …while the libraries themselves are still chunked.
    expect(vendorChunkFor('/node_modules/katex/dist/katex.js')).toBe('vendor-katex')
    expect(vendorChunkFor('/node_modules/highlight.js/lib/core.js')).toBe('vendor-highlight')
    expect(vendorChunkFor('C:\\app\\node_modules\\katex\\dist\\katex.min.css')).toBeUndefined()
  })

  it('routes every d3 package to vendor-d3, and only d3', () => {
    expect(vendorChunkFor('/node_modules/d3/dist/d3.js')).toBe('vendor-d3')
    expect(vendorChunkFor('/node_modules/d3-scale/dist/d3-scale.js')).toBe('vendor-d3')
    // unrelated package whose name merely contains "d3" must NOT be captured
    expect(vendorChunkFor('/node_modules/@foo/d3thing/dist/x.js')).not.toBe('vendor-d3')
  })

  it('routes the heavy libraries to explicit, stable chunk names', () => {
    expect(vendorChunkFor('/node_modules/highlight.js/lib/core.js')).toBe('vendor-highlight')
    expect(vendorChunkFor('/node_modules/dagre-d3-es/dist/dagre-d3-es.js')).toBe('vendor-dagre')
    expect(vendorChunkFor('/node_modules/chevrotain/dist/chevrotain.js')).toBe('vendor-chevrotain')
    expect(vendorChunkFor('/node_modules/@chevrotain/regexp-to-ast/dist/index.js')).toBe(
      'vendor-chevrotain',
    )
    expect(vendorChunkFor('/node_modules/lodash-es/lodash.js')).toBe('vendor-lodash')
    expect(vendorChunkFor('/node_modules/lucide-react/dist/lucide-react.js')).toBe('vendor-lucide')
    expect(vendorChunkFor('/node_modules/khroma/dist/khroma.js')).toBe('vendor-khroma')
    expect(vendorChunkFor('/node_modules/es-toolkit/dist/es-toolkit.js')).toBe('vendor-es-toolkit')
  })

  it('gives every other node_modules package its own (filesystem-safe) chunk', () => {
    expect(vendorChunkFor('/node_modules/react/index.js')).toBe('vendor-react')
    expect(vendorChunkFor('/node_modules/react-dom/index.js')).toBe('vendor-react-dom')
    expect(vendorChunkFor('/node_modules/zustand/index.js')).toBe('vendor-zustand')
    expect(vendorChunkFor('/node_modules/dayjs/dayjs.min.js')).toBe('vendor-dayjs')
    // scoped packages are sanitized (slashes / @ collapsed to dashes)
    expect(vendorChunkFor('/node_modules/@foo/bar/dist/x.js')).toBe('vendor--foo-bar')
  })
})
