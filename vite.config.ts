import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import { notBundle } from 'vite-plugin-electron/plugin'
import { fileURLToPath } from 'node:url'

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
  // Worker 内 unified 管线依赖若干“同形（isomorphic）”包，这些包的 package.json
  // 为浏览器环境解析到带 DOM 依赖的变体（如 decode-named-character-reference 的
  // index.dom.js 用 document.createElement；hast-util-from-html-isomorphic 的
  // lib/browser.js 用 DOMParser）。Web Worker 既没有 document 也没有 DOMParser，
  // 会导致 Worker 加载即抛 `document is not defined` / `DOMParser is not defined`、
  // comlink 调用永久挂起、预览一直停在 "Loading preview…"。
  //
  // 这些包都已提供 `worker`（及 default）导出条件，指向 DOM-free 变体。这里用别名
  // 强制走这些版本（渲染进程同样可用，无副作用）。别名在 dev 预打包与 build 中均生效，
  // 是最可靠的修复手段。
  resolve: {
    alias: {
      'decode-named-character-reference': fileURLToPath(
        new URL('./node_modules/decode-named-character-reference/index.js', import.meta.url)
      ),
      'hast-util-from-html-isomorphic': fileURLToPath(
        new URL('./node_modules/hast-util-from-html-isomorphic/index.js', import.meta.url)
      ),
    },
  },
  // 解析 Worker（parse.worker.ts）构建为 ES module（R1/G5）。
  // 严禁为此新增 electron 插件的 renderer 选项（见下方注释）。
  // 额外：让 Worker 构建优先解析 `worker` 导出条件（而非默认的 `browser`），
  // 覆盖任何遗漏的同类包（unified 生态普遍提供 worker 条件），避免 DOM 依赖进入 Worker。
  worker: {
    format: 'es',
    resolve: {
      conditions: ['worker', 'browser', 'module', 'import', 'default'],
    },
  },
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
