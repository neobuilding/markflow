import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import { fileURLToPath } from 'node:url'
import checker from 'vite-plugin-checker'

// ROOT CAUSE FIX: Clear ELECTRON_RUN_AS_NODE so Electron runs in full mode
// (not as pure Node.js). This env var disables Electron's module interception,
// causing require('electron') to fail. It may be set by the host environment.
delete process.env.ELECTRON_RUN_AS_NODE

export default defineConfig({
  // Renderer is loaded from a file:// URL in production; relative paths are
  // required for dynamic imports (e.g., Mermaid chunks) and asset URLs to
  // resolve correctly inside the app bundle. A root-relative base would make
  // chunks point to /assets/... on the filesystem, where they don't exist.
  base: './',
  // The unified pipeline inside the Worker depends on several "isomorphic" packages
  // whose package.json resolves to DOM-dependent variants for the browser (e.g.
  // decode-named-character-reference's index.dom.js uses document.createElement;
  // hast-util-from-html-isomorphic's lib/browser.js uses DOMParser). A Web Worker has
  // neither document nor DOMParser, which would make the Worker throw
  // `document is not defined` / `DOMParser is not defined` on load, hang the comlink
  // call forever, and leave the preview stuck at "Loading preview…".
  //
  // These packages all provide a `worker` (and default) export condition pointing to
  // DOM-free variants. We force those versions via aliases (also usable in the renderer,
  // no side effects). The alias takes effect in both dev pre-bundling and build, and is
  // the most reliable fix.
  resolve: {
    // Prefer the `worker` export condition ahead of `browser` for the whole build
    // (including the Parse Worker). The unified ecosystem widely ships a DOM-free
    // `worker` variant; selecting it first keeps DOM-dependent code out of the
    // Web Worker (which lacks `document`/`DOMParser`), preventing runtime
    // "document is not defined" crashes there. The two aliases below provide the
    // same guarantee for the packages that don't expose a `worker` condition.
    conditions: ['worker', 'browser', 'module', 'import', 'default'],
    alias: {
      'decode-named-character-reference': fileURLToPath(
        new URL('./node_modules/decode-named-character-reference/index.js', import.meta.url),
      ),
      'hast-util-from-html-isomorphic': fileURLToPath(
        new URL('./node_modules/hast-util-from-html-isomorphic/index.js', import.meta.url),
      ),
    },
  },
  // Build the Worker (parse.worker.ts) as an ES module (R1/G5).
  // Do NOT add a renderer option to the electron plugin for this (see comment below).
  worker: {
    format: 'es',
  },
  plugins: [
    react(),
    // Live type-checking feedback during dev/build (does NOT fail the build;
    // the hard gate lives in the `quality` script's `typecheck` step).
    checker({ typescript: { tsconfigPath: 'tsconfig.web.json' } }),
    electron({
      main: {
        entry: 'electron/main/index.ts',
        vite: {
          build: {
            rollupOptions: {
              output: {
                entryFileNames: 'index.js',
              },
            },
          },
        },
      },
      preload: {
        input: 'electron/preload/index.ts',
        vite: {
          build: {
            rollupOptions: {
              output: {
                // Force CommonJS output. Under "type": "module" in package.json,
                // Node treats bare `.js` files as ESM and `require` is undefined,
                // so the preload would fail to load ("require is not defined") and
                // window.api would be undefined — crashing the renderer. Emitting
                // a `.cjs` entry keeps it CommonJS regardless of the package type.
                entryFileNames: 'preload.cjs',
                format: 'cjs',
              },
            },
          },
        },
      },
      // IMPORTANT: Do NOT add a `renderer` option here.
      // When `renderer` is set (even to {}), vite-plugin-electron/simple
      // auto-loads vite-plugin-electron-renderer, which polyfills Node.js
      // `require()` into the renderer process. But our renderer runs with
      // contextIsolation:true + nodeIntegration:false, so `require` does
      // not exist there — causing "require is not defined" and breaking all
      // module loading (blank window). We access Electron only via the
      // preload bridge (window.api), so the renderer plugin is unnecessary.
    }),
  ],
  root: '.',
  server: {
    port: 5174,
    strictPort: false,
    // Key: In Vite dev mode, changes to .html files in the project root trigger a full page
    // reload. When the user exports HTML into the project (e.g. examples/demo.html), the write
    // is misread as a source change, causing the renderer to reload and lose workspace state.
    // Here we ignore changes to any .html other than index.html — keeping index.html hot-reload
    // while avoiding accidental reloads from export operations.
    watch: {
      ignored: (path) => /[^/\\]\.html$/i.test(path) && !/index\.html$/i.test(path),
    },
  },
  build: {
    outDir: 'dist/renderer',
    // Split heavy vendors into their own chunks. Without this, a single bundled
    // chunk (notably mermaid/katex) exceeds Vite's default 500 KB warning limit
    // and emits a "chunk size" warning on every build. Isolating vendors keeps
    // the app code chunk small and makes cache invalidation granular.
    //
    // The largest chunks are inherently big diagram/editor libraries, not a
    // regression from this branch: mermaid (~2.4 MB) and its transitive d3
    // dependency (~2.8 MB in `vendor`), plus CodeMirror (~1.6 MB). We raise the
    // warning limit above those known sizes so the build stays warning-free
    // while the chunks remain split for caching.
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('mermaid')) return 'vendor-mermaid'
          if (id.includes('katex') || id.includes('mathjax')) return 'vendor-katex'
          if (id.includes('codemirror') || id.includes('@lezer')) return 'vendor-editor'
          if (id.includes('@radix-ui') || id.includes('@tanstack')) return 'vendor-ui'
          return 'vendor'
        },
      },
    },
  },
})
