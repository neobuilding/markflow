import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import { fileURLToPath } from 'node:url'
import { relative } from 'node:path'
import checker from 'vite-plugin-checker'
import { pruneKaTeXFallbacks } from './scripts/prune-fonts.ts'
import { vendorChunkFor } from './scripts/vendor-chunks.ts'

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
  // call forever, and leave the preview stuck at "Loading preview"
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
    // Drop KaTeX's redundant .ttf/.woff fallbacks from the renderer bundle (build only).
    pruneKaTeXFallbacks(),
    // Live type-checking feedback during dev/build (does NOT fail the build;
    // the hard gate lives in the `quality` script's `typecheck` step).
    checker({ typescript: { tsconfigPath: 'tsconfig.web.json' } }),
    electron({
      main: {
        entry: 'electron/main/index.ts',
        vite: {
          build: {
            // Output the electron main process under dist/electron (alongside the
            // renderer build in dist/renderer), so every bundler artifact lives under
            // one dist/ root and the packaged app stays in release/.
            outDir: 'dist/electron',
            // main + preload share this dir; never let one build wipe the other's output.
            emptyOutDir: false,
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
            outDir: 'dist/electron',
            emptyOutDir: false,
            rollupOptions: {
              output: {
                // Force CommonJS output. Under "type": "module" in package.json,
                // Node treats bare `.js` files as ESM and `require` is undefined,
                // so the preload would fail to load ("require is not defined") and
                // window.api would be undefined crashing the renderer. Emitting
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
      // not exist there causing "require is not defined" and breaking all
      // module loading (blank window). We access Electron only via the
      // preload bridge (window.api), so the renderer plugin is unnecessary.
    }),
  ],
  root: '.',
  server: {
    port: 5174,
    strictPort: false,
    // Dev-server file watch scope. The renderer is served from index.html; in dev
    // mode a change to a watched .html triggers a full page reload. We must keep
    // index.html hot-reloaded but avoid reloads from app DATA writes (e.g. a user
    // exporting HTML into examples/). The WHITELIST below achieves this cleanly:
    // only src/shared + root config are watched, so any exported html lands in an
    // unwatched data directory and never triggers a reload. Packaged builds have no
    // Vite watcher at all.
    watch: {
      // Watch WHITELIST (not blacklist) of what the Vite dev server must track for
      // HMR. The renderer's entire import graph is confined to `src/` (entry:
      // src/renderer/src/main.tsx) and `shared/` (i18n), plus a few root config
      // files. Everything else — user data folders the app can edit/delete
      // (examples, docs, docs.local, notes, …), build/test output (coverage,
      // dist/electron, release, out) and standalone Node tooling (actions, scripts,
      // e2e) — must NOT be watched. If Vite's chokidar holds a directory handle on a
      // watched folder, shell.trashItem's recycle rename on Windows is blocked and the
      // OS raises the "needs admin permission" elevation prompt; the app's own
      // watcher is released by folderWatcher.pauseFolderWatching, but it cannot
      // release Vite's handle. A blacklist would silently start watching any NEW data
      // directory and re-introduce that bug; a whitelist makes it impossible by
      // construction. (electron/main + electron/preload are watched by
      // vite-plugin-electron's own watcher, independent of this dev-server watch.)
      //
      // chokidar has no native multi-root/allowlist, so we invert the predicate:
      // ignore everything EXCEPT the allowlist. The repo root itself must NOT be
      // ignored or chokidar traverses nothing — handled by the `rel === ''` guard.
      // Paths are normalised via path.relative(process.cwd(), …) so the check is
      // correct on Windows, where chokidar passes ABSOLUTE paths (a naive
      // split(/[/\\]/)[0] would return the drive letter and match nothing).
      ignored: (path) => {
        const rel = relative(process.cwd(), String(path)).replace(/[\\/]+/g, '/')
        if (rel === '') return false // repo root: must be watched to reach src/shared
        const top = rel.split('/', 1)[0]
        const ALLOWED = [
          'src', // renderer source (entry src/renderer/src/main.tsx)
          'shared', // i18n imported by the renderer
          'index.html', // full-reload trigger on change
          'vite.config.ts', // dev-server config reload
          'postcss.config.ts', // CSS pipeline
          'tailwind.config.cjs', // Tailwind content/presets
        ]
        return !ALLOWED.includes(top) && !ALLOWED.includes(rel)
      },
    },
  },
  build: {
    outDir: 'dist/renderer',
    // Split third-party libraries into their own chunks so the app-code chunk stays
    // small and cache invalidation is granular. The actual policy lives in
    // scripts/vendor-chunks.ts (vendorChunkFor): a few families (mermaid, katex, the
    // CodeMirror/lezer editor stack, the radix-ui/tanstack UI stack, d3) get grouped
    // chunks, and EVERY other node_modules package gets its OWN chunk. This stops any
    // catch-all `vendor` chunk from aggregating enough modules to exceed
    // chunkSizeWarningLimit (3000 kB), so the build is warning-free — verified by the
    // build (no "larger than 3000 kB" warning) and by scripts/vendor-chunks.test.ts.
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      output: {
        manualChunks: vendorChunkFor,
      },
    },
  },
})
