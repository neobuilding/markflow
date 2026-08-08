# MarkFlow — 快速启动参考

## 环境要求

- Node.js >= 22
- npm >= 9
- Electron 43（随 `npm install` 一同安装）

> **TypeScript 7 过渡期说明**：当前项目使用 TypeScript 7，而 `typescript-eslint` 的官方支持尚未覆盖 TS7。因此 `postinstall` 与 `lint` 会通过 `scripts/install-eslint-ts6.mjs` 并行安装 TS6 的 side-by-side shim 仅供 ESLint 使用（不影响应用运行）。待 `typescript-eslint` 官方支持 TS7 后可移除该过渡方案。

## 开发

```bash
cd markflow
npm install
npm run dev
```

## 打包

```bash
npm run dist:win      # Windows 解压版（免安装，开箱即用）
npm run dist:mac      # macOS DMG
npm run dist:linux    # Linux AppImage / deb / rpm
npm run dist          # 当前平台自动选择
```

## 质量门禁

提交前请运行：

```bash
npm run quality       # Prettier 格式检查 + Stylelint + Markdownlint + Secretlint
```

`pre-commit` 钩子会自动对暂存文件运行 lint-staged（Stylelint + Markdownlint + Prettier）。

## 文件说明

| 文件/目录                                | 用途                                                   |
| ---------------------------------------- | ------------------------------------------------------ |
| `vite.config.ts`                         | Vite 配置（renderer + electron，vite-plugin-electron） |
| `electron-builder.json5`                 | 打包配置（输出目录、图标、DMG/NSIS 设置）              |
| `electron/main/`                         | Electron 主进程                                        |
| `electron/main/db/database.ts`           | SQLite 初始化 + FTS5 迁移                              |
| `electron/main/ipc/documents.ts`         | 文档 CRUD IPC 处理器                                   |
| `electron/main/ipc/search.ts`            | FTS5 全文搜索 IPC 处理器                               |
| `electron/preload/index.ts`              | contextBridge 暴露 API                                 |
| `src/renderer/src/`                      | React 渲染层                                           |
| `src/renderer/src/store/ui.ts`           | Zustand UI 状态                                        |
| `src/renderer/src/hooks/useDocuments.ts` | TanStack Query 文档操作                                |
| `src/renderer/src/hooks/useSearch.ts`    | TanStack Query 搜索                                    |
| `src/renderer/src/components/editor/`    | 编辑器 + 命令面板                                      |
| `src/renderer/src/components/sidebar/`   | 文档侧边栏                                             |
| `src/renderer/src/components/preview/`   | Markdown 预览                                          |
