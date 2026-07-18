import { defineConfig } from 'vitest/config'

// 独立配置：Vitest 优先读取本文件而非 vite.config.ts，
// 避免 vite-plugin-electron 在跑单测时构建主进程/预加载。
// 渲染子系统为纯逻辑（markdownPipeline / sanitize），无需 React 插件。
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/renderer/src/**/*.test.ts'],
    // 解析 Worker 用到的“同形”包别名（与 vite.config.ts 对齐），
    // 确保 markdownPipeline 在测试中也走 DOM-free 变体（虽本测试不进 Worker，
    // 但保持与构建一致，避免潜在解析差异）。
    resolve: {
      alias: {
        'decode-named-character-reference': new URL(
          './node_modules/decode-named-character-reference/index.js',
          import.meta.url
        ).pathname,
        'hast-util-from-html-isomorphic': new URL(
          './node_modules/hast-util-from-html-isomorphic/index.js',
          import.meta.url
        ).pathname,
      },
    },
  },
})
