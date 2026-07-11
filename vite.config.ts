import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import { notBundle } from 'vite-plugin-electron/plugin'

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
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main/index.ts',
        vite: {
          // notBundle() keeps all dependencies as external requires (not bundled).
          // Required for native modules like better-sqlite3 whose .node binaries
          // cannot be processed by Rollup.
          plugins: [notBundle()],
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
                entryFileNames: 'preload.js',
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
  },
  build: {
    outDir: 'dist/renderer',
  },
})
