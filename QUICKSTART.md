# MarkFlow — 快速启动参考

## 环境要求

- Node.js >= 22
- npm >= 9
- Electron 44（随 `npm install` 一同安装）

> **TypeScript 7 过渡期说明**：当前项目使用 TypeScript 7，而 `typescript-eslint` 的官方支持尚未覆盖 TS7。因此 `postinstall` 与 `lint` 会通过 `scripts/install-eslint-ts6.mjs` 并行安装 TS6 的 side-by-side shim 仅供 ESLint 使用（不影响应用运行）。待 `typescript-eslint` 官方支持 TS7 后可移除该过渡方案。

## 开发

```bash
cd markflow
npm install
npm run dev
```

## 打包

```bash
npm run dist:win      # Windows .zip（免安装，解压即用）
npm run dist:mac      # macOS DMG
npm run dist:linux    # Linux AppImage
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
npm run e2e:full        # 端到端：用 Playwright 驱动真实的 Electron 应用
```

- **单元测试**（`npm run test:coverage`）在 jsdom 下运行，不会触发 Electron 构建，速度快、无需显示服务。
- **端到端测试**（`npm run e2e:full`）会启动真实的 Electron 应用：`e2e/global-setup.ts` 启动共享的 Vite dev server 并等待 `dist/electron/index.js` 编译完成，因此需先 `npm run build`；每个 spec 再各自启动一个 Electron 实例。在无显示的 Linux（如 CI）上需借助虚拟显示运行：

  ```bash
  xvfb-run --auto-servernum -- npm run e2e:full
  ```

- **e2e 脚本族**：`e2e:app`（仅功能/行为 spec，210 例）、`e2e:clipboard`（仅写真实系统剪贴板的 21 例，破坏性）、`e2e:perf-gate`（仅性能门禁，2 例）、`e2e:perf-diag`（无阈值诊断，按需，1 例）、`e2e:full`（覆盖与 CI 相同 project 的本地组合 = **两次** Playwright 运行：先 `e2e-app` + `e2e-clipboard`，产出 `playwright-report/` 与 `reports/e2e/junit.xml`；再 `e2e-perf-gate` **独占一次调用**）。
- **性能门禁必须独占一次调用**：Playwright 会把**同一次调用里的多个 project 并发**调度（实测 2026-11-05：三个用例分属两个 project，墙钟 12.7s，而各用例自身耗时合计 21.1s），所以与 `e2e-app`（当时 297 个用例、约 10.6 分钟）共享一次调用时，计时门禁会把机器负载算进阈值：`firstContentMs` 实测 1602ms 越过 1500ms 阈值而变红，独立调用则实测 712ms 通过。阈值本身不动（应用仍比冻结基线 2644ms 快约 3 倍），改的是测量条件。第二次调用带 `--reporter=line --output=test-results/perf-gate`：CI 下 html/junit reporter 是开启的（本地只有 `list`），不带这个 flag 时第二次调用会**覆盖**第一次的 `playwright-report/` 与 `reports/e2e/junit.xml`（实测：带 flag 两者时间戳不变，不带则被改写）。该约束由 `e2e/guards/e2e-parallelism.test.ts` 钉住。
- **性能门禁**：`npm run e2e:full` 覆盖三个 Playwright project：`e2e-app`（功能）、`e2e-clipboard`（破坏性：写真实系统剪贴板）与 `e2e-perf-gate`（性能门禁，独占一次调用）。性能门禁守护"文件夹监视器只监视 Markdown 文件"这条修复：在一个塞满非 Markdown 构建产物的文件夹里打开并立刻切换文档时，断言主进程事件循环不会被卡住（尖峰数与最大卡顿均有阈值），并同时跑带硬阈值的大文档 Phase-03 门禁（它也会先打印完整诊断报告）。`e2e-perf-diag` 是按需的诊断 project，只跑慢速、无阈值的文件夹切换诊断；带硬阈值的大文档门禁已归入 `e2e-perf-gate`（ADR-0034）：

  ```bash
  npm run e2e:perf-diag                                  # 合成 fixture
  PERF_FOLDER=D:/GitHub/markflow npm run e2e:perf-diag   # 实测真实目录
  ```

## Create-PR Action（本地构建与预览）

`actions/create-pr/` 是随仓库内置的 GitHub Action，用于从 head 分支幂等创建/刷新到 `main` 的 PR（完整设计与插件机制见 [`actions/create-pr/README.md`](actions/create-pr/README.md)）。两个根级脚本封装了它：

```bash
npm run build:action        # ncc 打包 src/index.mjs -> dist/index.mjs（由 auto-pr.yml 在运行时构建，dist/ 不提交）
npm run local-test-render    # 预览某分支将生成的 PR 正文（无需 token，无需 gh）
```

`npm run local-test-render` 直接调用 `actions/create-pr/src/cli-render.mjs`，无需 GitHub token 或 `gh` CLI，即可预览 Action 会写入 PR 的正文。它按默认模板解析 `feature/my-branch` 并打印渲染结果；可选参数：`--base main`、`--template .github/pull-request-template.md`、`--blocks-dir .github/create-pr/blocks`、`--no-git`、`--existing <body.md>`（预览对已有 PR 的刷新）。

> ℹ️ **改完 Action 后无需提交产物**：`actions/create-pr/dist/index.mjs` **不再提交**。`auto-pr.yml` 在 `uses: ./actions/create-pr` 之前会自动跑 `npm run build:action`，用已提交的 `src/` 现编 bundle，因此永远最新、不会过期。你只改 `src/`；本地预览/测试时再跑 `npm run build:action`（产物被 git 忽略）。

### CI 流水线（`.github/workflows/ci.yml`）

所有 job 全并发启动 —— `version`、`quality`、`ut`、各 e2e job 与三平台 `build` 同时开始（只有 `build` 依赖 `version`，用于注入计算出的版本号）：

- `quality`（ubuntu）：`npm run quality`（Prettier + ESLint + Stylelint + Markdownlint + Secretlint + 类型检查），整轮仅跑一次，且**刻意不做任何门禁**：格式/规则/类型错误不应掩盖测试与打包结果，一次运行就把所有问题一起暴露出来。
- `ut`（ubuntu）：单元测试 + 覆盖率（Vitest + jsdom，无需 Electron 构建）。
- `e2e-app-shard`（ubuntu，4 个并行 job）：安装 Playwright 浏览器 → `npm run build` → 在 `xvfb-run` 下 `npx playwright test --project=e2e-app --shard=N/4`。
- `e2e-serial`（ubuntu）：同样的准备步骤，之后分两次独立调用 `--project=e2e-clipboard` 与 `--project=e2e-perf-gate`（计时门禁不与其它 spec 共享机器）。
  每个 job 都在独立 runner 上（各自 `npm ci` + 一次 `npm run build`），以重复安装换取墙钟时间。Playwright 的 HTML 报告与 `test-results/` 会在每次运行（含失败）后作为产物上传，便于排查。

三平台 `build` 任务（`Build (macos-latest|windows-latest|ubuntu-latest)`）在版本计算完成后立即开始，**不等待**测试任务，因此打包问题与测试问题会在同一次运行中一起暴露。它是全仓库唯一的三平台构建，既用于 PR 校验也用于发布。

`release` 是整条流水线**唯一的门禁**：它依赖 `build`、`ut`、`e2e-app-shard`、`e2e-serial`、`quality` 和 `version`，因此任何一项失败都不会打 tag 或生成 draft release。另外，`pull_request` 触发的运行会被后续推送自动取消（`cancel-in-progress`），而推送到 `main` 的运行永不取消，以免发布构建被中途打断。

## 文件说明

| 文件/目录                                | 用途                                                   |
| ---------------------------------------- | ------------------------------------------------------ |
| `vite.config.ts`                         | Vite 配置（renderer + electron，vite-plugin-electron） |
| `electron-builder.json5`                 | 打包配置                                               |
| `electron/main/`                         | Electron 主进程                                        |
| `electron/main/model/documentStore.ts`   | 内存文档存储                                           |
| `electron/main/model/folderWatcher.ts`   | chokidar 递归目录监听（磁盘变更同步进 store）          |
| `electron/main/ipc/documents.ts`         | 文档 CRUD IPC 处理器                                   |
| `electron/main/ipc/search.ts`            | minisearch 全文搜索 IPC 处理器                         |
| `electron/preload/index.ts`              | contextBridge 暴露 API                                 |
| `src/renderer/src/`                      | React 渲染层                                           |
| `src/renderer/src/store/ui.ts`           | Zustand UI 状态                                        |
| `src/renderer/src/hooks/useDocuments.ts` | TanStack Query 文档操作                                |
| `src/renderer/src/hooks/useSearch.ts`    | TanStack Query 搜索                                    |
| `src/renderer/src/components/editor/`    | 编辑器 + 命令面板                                      |
| `src/renderer/src/components/sidebar/`   | 文档侧边栏                                             |
| `src/renderer/src/components/preview/`   | Markdown 预览                                          |
