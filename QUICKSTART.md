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

## 测试与 CI

两层测试可在本地与 CI 中运行：

```bash
npm run test:coverage   # 单元测试（Vitest + jsdom）+ 覆盖率，无需构建 Electron
npm run e2e             # 端到端：用 Playwright 驱动真实的 Electron 应用
```

- **单元测试**（`npm run test:coverage`）在 jsdom 下运行，不会触发 Electron 构建，速度快、无需显示服务。
- **端到端测试**（`npm run e2e`）会启动真实的 Electron 应用：`e2e/global-setup.ts` 启动共享的 Vite dev server 并等待 `dist-electron/index.js` 编译完成，因此需先 `npm run build`；每个 spec 再各自启动一个 Electron 实例。在无显示的 Linux（如 CI）上需借助虚拟显示运行：

  ```bash
  xvfb-run --auto-servernum -- npm run e2e
  ```

### CI 流水线（`.github/workflows/ci.yml`）

`Test, Build & E2E` 任务（ubuntu）依次执行：`npm run quality`（Prettier + ESLint + Stylelint + Markdownlint + Secretlint + 类型检查，作为快速失败门禁）→ 单元测试 + 覆盖率 → 安装 Playwright 浏览器 → `npm run build` → 在 `xvfb-run` 下 `npm run e2e`。e2e 步骤刻意合并进该任务，复用同一 runner、一次 `npm ci` 安装与一次 `npm run build`，避免额外启动一个 runner（省一次完整安装 + 一次构建）。Playwright 的 HTML 报告与 `test-results/` 会在每次运行（含失败）后作为产物上传，便于排查。

三平台 `build` 任务（`Build (macos|windows|ubuntu)`）在该测试任务之后运行，是全仓库唯一的三平台构建，既用于 PR 校验也用于发布。

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
