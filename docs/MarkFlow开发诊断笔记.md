# MarkFlow 开发诊断笔记

> 生成时间：2026-06-20（第五版，合并 CI + Release 为单一 ci.yml，删除独立 release.yml）  
> 项目路径：`C:\Users\yaolin\WorkBuddy\2026-06-18-21-41-06\markflow\`  
> 工作路径限定：`C:\Users\yaolin\WorkBuddy\2026-06-18-21-41-06\markflow`（不再引用 `D:\GitHub\markflow`）  
> 目标：记录开发过程中遇到的问题、根因分析和解决方案，作为后续工作参考

---

## 一、项目背景

### 技术栈

| 层级 | 技术选型 |
|------|---------|
| 构建工具 | `vite-plugin-electron/simple` + `notBundle()` |
| 桌面框架 | Electron 30 |
| 前端框架 | React 18 + TypeScript (strict) + Tailwind CSS 3.4 + shadcn/ui |
| 状态管理 | Zustand（UI 状态）+ TanStack Query v5（IPC 状态） |
| 存储层 | `better-sqlite3`（元数据 + FTS5 全文索引）+ Markdown 文件双写 |
| 编辑器 | CodeMirror 6 |
| 打包 | electron-builder |

### 目录结构

```
markflow/
├── electron/
│   ├── main/
│   │   ├── index.ts          # 主进程入口
│   │   ├── ipc/
│   │   │   ├── documents.ts  # 文档 IPC handlers
│   │   │   └── search.ts     # 搜索 IPC handlers
│   │   └── db/
│   │       └── database.ts   # better-sqlite3 初始化 + FTS5
│   └── preload/
│       └── index.ts          # contextBridge 预加载脚本
├── src/
│   └── renderer/             # React 渲染进程源码
├── index.html                # Vite 入口（项目根目录）
├── vite.config.ts            # vite-plugin-electron/simple 配置
├── postcss.config.cjs        # PostCSS 配置（CJS 格式）
├── tailwind.config.cjs       # Tailwind 配置（CJS 格式）
├── tsconfig.json             # 根 TS 配置（渲染进程）
├── tsconfig.node.json        # 主进程/预加载 TS 配置
├── tsconfig.web.json         # 渲染进程 TS 配置
├── package.json
└── electron-builder.json5
```

---

## 二、核心问题：`require('electron')` 失败（已解决 ✅）

### 2.1 问题描述

主进程代码运行时，无论用 CJS `require('electron')` 还是 ESM `import { app } from 'electron'`，都无法正确获取 Electron API：

- **CJS**：`const { app } = require('electron')` → 返回路径字符串，`app is undefined`
- **ESM**：`import { app } from 'electron'` → `SyntaxError: does not provide an export named 'app'`
- `process.type` 为 `undefined`（正常主进程应为 `"browser"`）

### 2.2 真正的根因：`ELECTRON_RUN_AS_NODE=1` 环境变量

**这是唯一真正的根因。** 之前所有关于 "Electron 30 模块拦截 bug"、"node_modules/electron/index.js 劫持" 的分析都是错误方向。

`ELECTRON_RUN_AS_NODE=1` 是 Electron 的官方环境变量，作用是让 `electron.exe` 以**纯 Node.js 模式**运行，完全跳过 Electron 的初始化流程：

| 行为 | 正常 Electron 模式 | `ELECTRON_RUN_AS_NODE=1` |
|------|-------------------|--------------------------|
| `process.type` | `"browser"`（主进程） | `undefined` |
| `require('electron')` | Electron 内置拦截 → 返回 API 对象 | 无拦截 → 解析到 `node_modules/electron/index.js`（路径字符串） |
| `BrowserWindow` 等 API | ✅ 可用 | ❌ 不可用 |
| 窗口/GUI | ✅ 可用 | ❌ 不可用 |

**在本项目中**，宿主环境（WorkBuddy Desktop）的全局 shell 环境设置了 `ELECTRON_RUN_AS_NODE=1`。`vite-plugin-electron` 启动 Electron 时继承了该环境变量，导致 Electron 以纯 Node.js 模式运行，所有 Electron 功能失效。

### 2.3 验证实验

```bash
# WITH ELECTRON_RUN_AS_NODE=1 → FAIL
$ ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe test.js
Error: Cannot find module 'electron'  # 拦截未生效

# WITHOUT ELECTRON_RUN_AS_NODE → SUCCESS
$ unset ELECTRON_RUN_AS_NODE
$ node_modules/electron/dist/electron.exe test.js
typeof electron: object
process.type: browser
process.versions.electron: 30.5.1
SUCCESS: electron.app is available!
```

### 2.4 解决方案

在 `vite.config.ts` 顶部添加一行：

```typescript
// 清除 ELECTRON_RUN_AS_NODE，确保 Electron 以完整模式运行
delete process.env.ELECTRON_RUN_AS_NODE
```

`vite.config.ts` 运行在与 Electron 子进程相同的 Node.js 进程中，清除该变量后，子进程不再继承它，Electron 正常初始化，`require('electron')` 被 Electron 内置机制正确拦截。

### 2.5 之前走过的弯路（全部基于错误假设）

| # | 尝试的方案 | 为什么无效 |
|---|-----------|-----------|
| 1 | 删除 `node_modules/electron/index.js` | 问题不在 index.js，而在环境变量 |
| 2 | 修改 `index.js` 检测环境返回内置模块 | 环境变量导致 Electron 根本没初始化 |
| 3 | 尝试 `process._linkedBinding('electron')` 获取内置模块 | Electron 30 报错 `No such binding was linked: electron` |
| 4 | 设置 `ELECTRON_EXEC_PATH` 环境变量 | 工具链未正确使用，无效 |
| 5 | 移动 `electron` 依赖位置（devDeps → deps） | 与依赖位置无关 |
| 6 | 卸载 `electron` npm 包 | TypeScript 找不到类型声明 |
| 7 | 重命名 `node_modules/electron/` 目录 | `require('electron')` 直接报 `MODULE_NOT_FOUND` |
| 8 | `prestart.js` 启动前 rename 目录 | rename 后二进制路径失效 |
| 9 | 手动重建 `cli.js`（直接读 `path.txt` 启动） | Electron 拦截机制仍因环境变量失效 |
| 10 | 从 `electron-vite` 迁移到纯 `vite + tsc` | 构建工具不是问题 |
| 11 | 使用 `vite-plugin-electron/simple` | 构建工具不是问题 |
| 12 | 添加 `"type": "module"` 用 ESM | ESM 在 Electron 30 上有 named export 问题 |
| 13 | 移除 `"type": "module"` 用 CJS | 模块格式不是问题，`require` 被环境变量禁用 |

**教训**：`process.type === undefined` 是关键线索，它直接表明代码不在 Electron 上下文中运行。应该优先排查环境变量，而不是模块解析机制。

---

## 三、其他问题及解决方案

### 3.1 `better-sqlite3` native 模块版本不匹配

**问题**：

```
The module 'better_sqlite3.node' was compiled against NODE_MODULE_VERSION 127.
This version of Node.js requires NODE_MODULE_VERSION 123.
```

**根因**：`better-sqlite3` 默认针对系统 Node.js (v22, MODULE_VERSION 127) 编译，但 Electron 30 内置 Node.js v20 (MODULE_VERSION 123)。

**解决方案**：

```bash
npm install @electron/rebuild --save-dev
npx electron-rebuild -f -w better-sqlite3
```

在 `package.json` 的 `postinstall` 中自动执行：

```json
"postinstall": "electron-rebuild -f -w better-sqlite3"
```

**状态**：✅ 已修复

### 3.2 TypeScript 编译错误

#### `better-sqlite3` ES module interop

**修复**：`tsconfig.node.json` 添加 `esModuleInterop: true` 和 `allowSyntheticDefaultImports: true`

#### 导入路径错误

**修复**：`./db/database` → `./database`

#### `createRequire` + `import.meta.url` 在 CJS 中不可用

**修复**：移除 `createRequire`，改回标准 `import`

**状态**：✅ 全部已修复

### 3.3 Vite 配置问题

#### 找不到 `index.html`

**修复**：将 `index.html` 移至项目根目录，`vite.config.ts` 设置 `root: '.'`

#### 端口冲突

**修复**：`server.port: 5174`，`strictPort: false`

#### `postcss.config.js` ESM 警告

**修复**：重命名为 `postcss.config.cjs`，内容改为 `module.exports = { ... }`

**状态**：✅ 全部已修复

### 3.4 Windows 环境问题

#### `npm install` 时文件锁定 (`EBUSY`)

**修复**：关闭所有 Node/Electron 进程，删除 `node_modules/`，重新安装

#### Electron 二进制下载慢

**修复**：`.npmrc` 添加 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`

**状态**：✅ 全部已修复

### 3.5 渲染层空白：`vite-plugin-electron-renderer` 注入 `require`（已解决 ✅）

**问题**：
窗口完全空白，DevTools 控制台报三个错误：

```
(index):4 Uncaught SyntaxError: The requested module '/@react-refresh' does not provide an export named 'injectIntoGlobalHook'
client:2 Uncaught ReferenceError: require is not defined
+src+renderer+src+main.tsx.mjs:2 Uncaught ReferenceError: require is not defined
```

**根因**：
`vite.config.ts` 中 `electron()` 调用配置了 `renderer: {}`。查看 `vite-plugin-electron/simple` 源码发现：

```javascript
if (options.renderer) try {
    const renderer = await import("vite-plugin-electron-renderer");
    plugins.push(renderer.default(options.renderer));
} catch (error) { ... }
```

即使 `renderer: {}`（空对象），也会自动加载 `vite-plugin-electron-renderer` 插件。该插件向渲染层注入 Node.js `require()` polyfill，用于在渲染进程中直接使用 Node/Electron 模块。但我们的渲染层配置为 `contextIsolation: true` + `nodeIntegration: false`，浏览器环境中没有 `require`，导致：

- `client:2`（Vite HMR client）被注入 `require` → `require is not defined`
- `main.tsx.mjs` 被注入 `require` → `require is not defined`
- React Refresh preamble 因模块系统损坏而无法加载 → `/@react-refresh` 导出错误

**关键认知**：`vite-plugin-electron-renderer` 是给"在渲染层直接 `import 'electron'`"的场景用的。我们通过 preload `contextBridge` 暴露 `window.api` 桥接，渲染层代码不直接使用任何 Node/Electron 模块，因此完全不需要此插件。

**解决方案**：
从 `vite.config.ts` 的 `electron()` 配置中移除 `renderer: {}`：

```typescript
electron({
  main: { ... },
  preload: { ... },
  // 不配置 renderer — 渲染层通过 window.api 桥接，不需要 renderer 插件
}),
```

**验证**：移除后，Vite dev server 转换的 `main.tsx` 使用标准 ES module `import`，不再有 `require()` 调用。`/@react-refresh` 模块正确导出 `injectIntoGlobalHook`。

### 3.6 CSP 阻止 Vite HMR 内联脚本（已解决 ✅）

**问题**：
`index.html` 中的 CSP 策略 `script-src 'self'` 阻止了 `@vitejs/plugin-react` 注入的内联 React Refresh preamble：

```html
<script type="module">import { injectIntoGlobalHook } from "/@react-refresh"; ...</script>
```

`'self'` 只允许同源外部脚本，不允许内联脚本（需要 `'unsafe-inline'` 或 nonce）。

**解决方案**：

1. 从 `index.html` 移除静态 CSP `<meta>` 标签
2. 在主进程中通过 `session.defaultSession.webRequest.onHeadersReceived` 动态设置 CSP：
   - **开发环境**：宽松策略，允许 `'unsafe-inline'`、`'unsafe-eval'` 和 dev server origin（支持 HMR + React Refresh）
   - **生产环境**：严格策略，仅允许 `'self'` 资源

```typescript
function setupCSP(): void {
  const isDev = !!VITE_DEV_SERVER_URL
  // 从 VITE_DEV_SERVER_URL 动态提取 origin，避免硬编码端口
  const policy = isDev
    ? `default-src 'self' ${origin}; script-src 'self' 'unsafe-inline' 'unsafe-eval' ${origin}; ...`
    : `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; ...`
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] } })
  })
}
```

**状态**：✅ 已修复

---

### `vite.config.ts`

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import { notBundle } from 'vite-plugin-electron/plugin'

// ROOT CAUSE FIX: Clear ELECTRON_RUN_AS_NODE so Electron runs in full mode
delete process.env.ELECTRON_RUN_AS_NODE

export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main/index.ts',
        vite: {
          plugins: [notBundle()],
          build: {
            rollupOptions: { output: { entryFileNames: 'index.js' } },
          },
        },
      },
      preload: {
        input: 'electron/preload/index.ts',
        vite: {
          build: {
            rollupOptions: { output: { entryFileNames: 'preload.js' } },
          },
        },
      },
      // ⚠️ 不要配置 renderer！详见 3.5 节。
      // renderer: {} 会自动加载 vite-plugin-electron-renderer，
      // 向渲染层注入 require()，在 contextIsolation 模式下导致空白窗口。
    }),
  ],
  root: '.',
  server: { port: 5174, strictPort: false },
  build: { outDir: 'dist/renderer' },
})
```

### `package.json`（关键字段）

```json
{
  "main": "dist-electron/index.js",
  "scripts": {
    "postinstall": "electron-rebuild -f -w better-sqlite3",
    "dev": "vite",
    "build": "vite build",
    "package:win": "npm run build && electron-builder --win"
  }
}
```

### 构建产物

```
dist-electron/
├── index.js     # 主进程（CJS，~20 kB）
└── preload.js   # 预加载（CJS，~1.6 kB）
dist/renderer/   # 渲染进程（Vite 标准构建）
```

---

## 五、关键知识点

### `ELECTRON_RUN_AS_NODE` 环境变量

这是 Electron 的官方环境变量。设置后 `electron.exe` 等价于 `node.exe`，不初始化任何 Electron 功能。常用于：

- 在 Electron 进程中运行纯 Node.js 脚本
- IDE/工具链（如 VS Code、WorkBuddy Desktop）内部使用

**风险**：如果宿主环境全局设置了此变量，所有子进程 Electron 实例都会受影响。在 Electron 项目的构建配置中应主动清除。

### `vite-plugin-electron/simple` + `notBundle()`

- `vite-plugin-electron/simple`：一体化配置 main/preload/renderer，兼容 Vite 5
- `vite-plugin-electron/multi-env`：需要 Vite 6+（有 `createBuilder` API），Vite 5 下不可用
- `notBundle()`：主进程不打包，保留 `require()` 原样输出，由 Electron 运行时解析。**必须使用**，否则 native 模块（如 `better-sqlite3`）的 `.node` 二进制会被 Rollup 尝试打包，报 `Could not dynamically require` 错误
- `esmShim()`：自动声明 `__dirname`/`__filename`，但会与 native 模块（如 `better-sqlite3` 的 `bindings.js`）中的 `__dirname` 声明冲突，**不要使用**
- 输出格式跟随 `package.json` 的 `"type"` 字段（无 `"type": "module"` → CJS）
- `vite-plugin-electron/simple` 自动注入 `VITE_DEV_SERVER_URL` 环境变量，主进程通过 `process.env['VITE_DEV_SERVER_URL']` 读取

### `renderer` 配置与 `vite-plugin-electron-renderer`（⚠️ 重要陷阱）

`vite-plugin-electron/simple` 的 `renderer` 选项**只要存在（即使是空对象 `{}`）**，就会自动 `import("vite-plugin-electron-renderer")` 并应用该插件。该插件的作用是让渲染进程可以直接 `import 'electron'` 或 Node 内置模块——通过在渲染层注入 `require()` polyfill 实现。

**与 contextIsolation 的冲突**：当渲染层配置为 `contextIsolation: true` + `nodeIntegration: false`（安全最佳实践），浏览器环境中没有 `require`，polyfill 注入会导致 `require is not defined` 错误，进而破坏整个模块系统（Vite HMR client、React Refresh、应用代码全部无法加载，窗口空白）。

**决策规则**：

- 渲染层通过 `contextBridge` 暴露 `window.api` 桥接 → **不要**配置 `renderer`
- 渲染层需要直接 `import 'electron'` / Node 模块 → 配置 `renderer`（但需要 `nodeIntegration` 或 sandbox polyfill）

### CSP 与 Vite HMR 的兼容性

Vite dev 模式下，`@vitejs/plugin-react` 会在 `index.html` 注入内联 `<script type="module">` 作为 React Refresh preamble。CSP `script-src 'self'` 会阻止内联脚本（需要 `'unsafe-inline'`），导致 React Refresh 无法初始化。

**最佳实践**：不在 `index.html` 写静态 CSP，而是在主进程中通过 `session.defaultSession.webRequest.onHeadersReceived` 动态设置——开发环境宽松（允许 `'unsafe-inline'` + dev server origin），生产环境严格。

### Electron native 模块重编译

Electron 内置的 Node.js 版本与系统 Node.js 不同，native 模块（如 `better-sqlite3`）必须针对 Electron 版本重编译：

```bash
npx electron-rebuild -f -w <module-name>
```

建议加入 `postinstall` 脚本自动化。

---

## 六、构建工具迁移历程

项目构建工具经历了三次变更，记录如下供未来参考。

### 阶段 1：`electron-vite`（初始方案）

最初按需求使用 `electron-vite`，但遇到问题：

- 构建产物 `out/main/index.js` 中 `const { app } = require("electron")` 运行时报错
- `electron-vite` 在 Windows + Electron 30 上有模块解析 bug
- 尝试了多种配置调整均无效

**决策**：放弃 `electron-vite`，迁移到纯 Vite 方案。

### 阶段 2：纯 `vite + tsc`（过渡方案）

用 `concurrently` 并行运行三个进程：

```json
"dev": "concurrently -k \"npm run dev:renderer\" \"npm run dev:main\" \"wait-on tcp:5174 && bash -c 'cross-env DEV_SERVER_URL=http://localhost:5174 electron .'\""
```

遇到的问题：

- `cross-env DEV_SERVER_URL=...` 在 Git Bash 中解析不正确，需用 `bash -c` 包裹
- `tsc -w` 编译 main/preload，Vite dev server 编译 renderer，三进程协调复杂
- 构建产物在 `out/`（main/preload）和 `dist/renderer/`（renderer）两个目录
- **`require('electron')` 问题依旧存在**（根因未找到）

### 阶段 3：`vite-plugin-electron/simple`（最终方案）

参考 `electron-vite-vue` 模板，改用 `vite-plugin-electron/simple`：

- 一体化配置 main/preload/renderer
- 自动处理 `electron` 模块外部化
- 构建产物统一到 `dist-electron/` 目录

迁移过程中的踩坑：

| 问题 | 解决方案 |
|------|---------|
| `vite-plugin-electron/multi-env` 需要 Vite 6+（有 `createBuilder` API） | 改用 `vite-plugin-electron/simple`（兼容 Vite 5） |
| `esmShim()` 自动声明 `__dirname`，与 `better-sqlite3` 的 `bindings.js` 中的 `__dirname` 冲突 | 移除 `esmShim()`，手动处理 `__dirname` |
| `index.html` 的 `src` 路径从 `/src/main.tsx` 需改为 `/src/renderer/src/main.tsx` | 更新 `index.html` |
| `package.json` 的 `main` 字段多次调整：`dist-electron/main/index.js` → `dist-electron/index.mjs` → `dist-electron/index.js` | 最终确定为 `dist-electron/index.js` |
| `VITE_DEV_SERVER_URL` 环境变量（`vite-plugin-electron/simple` 自动注入） | 主进程通过 `process.env['VITE_DEV_SERVER_URL']` 读取 |
| 删除 `node_modules/electron/index.js` 后 `vite-plugin-electron` 找不到 Electron 二进制 | 必须保留 `index.js`（给工具链用），Electron 运行时的拦截由环境变量控制 |
| `vite-plugin-electron-renderer` 安装时 SSL 错误（临时网络问题） | 重试安装成功 |

### 关键教训

1. **构建工具不是根因**：在找到 `ELECTRON_RUN_AS_NODE` 根因之前，三次迁移构建工具都没有解决问题
2. **`vite-plugin-electron/simple` 是 Vite 5 下的正确选择**：`/multi-env` 需要 Vite 6+
3. **`esmShim()` 有副作用**：会自动声明 `__dirname`/`__filename`，与 native 模块的 `bindings.js` 冲突

---

## 七、其他零散踩坑点

### 7.1 `node_modules/electron/` 被意外删除

调试过程中，多次因为手动操作导致 `node_modules/electron/` 目录被删除或损坏：

- `npm install` 时 Windows 文件锁导致目录不完整
- 手动 `rm -rf node_modules/electron` 后无法用 `npm install --force` 恢复（npm 认为已是最新版）

**解决方案**：必须 `rm -rf node_modules/electron` 后用 `npm install electron@30 --save-dev`（不带 `--force`）重新安装。

### 7.2 `electron-builder.json5` 配置演变

```json5
// 初始配置
{ "directories": { "output": "dist" } }

// 迁移到 vite-plugin-electron 后
{ "directories": { "output": "release" } }  // 避免与 dist/renderer 冲突

// asarUnpack 路径修正
// 错误："dist-electron/main/**/*.node"（native 模块不在 dist-electron 里）
// 正确："node_modules/better-sqlite3/**"
```

### 7.3 `process._linkedBinding('electron')` 不可行

尝试用 `process._linkedBinding('electron')` 直接获取 Electron 内置模块，绕过 `require` 拦截：

```javascript
const electron = process._linkedBinding('electron')
// Error: No such binding was linked: electron
```

**结论**：Electron 30 不支持通过 `_linkedBinding` 获取 electron 模块，只能依赖 `require('electron')` 的内置拦截。

### 7.4 `RENDERER_DIST` 路径计算

主进程中渲染进程文件的路径计算需要特别注意：

```typescript
// electron/main/index.ts
// 生产：app.getAppPath() = ".../app.asar"
// RENDERER_DIST = join(app.getAppPath(), 'dist', 'renderer')
// = ".../app.asar/dist/renderer"
// 使用 loadURL(pathToFileURL(indexPath).href) 加载 asar 内的 index.html
export const RENDERER_DIST = join(app.getAppPath(), 'dist', 'renderer')
```

### 7.5 工作路径限定（2026-06-20）

本项目的工作路径已严格限定在 `C:\Users\yaolin\WorkBuddy\2026-06-18-21-41-06\markflow`。后续所有代码操作、文件读取、构建产物均应在此路径下进行，不再引用 `D:\GitHub\markflow` 等外部路径。

---

## 八、无害警告说明

以下警告在 `npm run dev` 输出中会出现，但**不影响功能**，无需处理：

### 8.1 `Unknown input options: platform` / `Unknown output options: codeSplitting`

```
Unknown input options: platform. Allowed options: ...
Unknown output options: codeSplitting. Allowed options: ...
```

**原因**：`vite-plugin-electron` 向 Rollup 传递了 `platform` 和 `codeSplitting` 选项，但当前 Rollup 版本不支持这些选项。
**影响**：无，Rollup 忽略未知选项。
**处理**：忽略。

### 8.2 `Autofill.enable` DevTools 警告

```
"Request Autofill.enable failed. {"code":-32601,"message":"'Autofill.enable' wasn't found"}"
```

**原因**：DevTools 尝试启用 Autofill 功能，但 Electron 30 的 DevTools 协议不完全支持。
**影响**：无，仅 DevTools 内部协议错误。
**处理**：忽略。

### 8.3 `CJS build of Vite's Node API is deprecated`

```
The CJS build of Vite's Node API is deprecated.
```

**原因**：`vite.config.ts` 以 CJS 模式加载（因为 `package.json` 无 `"type": "module"`），Vite 5 弃用了 CJS Node API。
**影响**：功能正常，未来 Vite 6+ 可能不兼容。
**处理**：当前忽略。如果未来升级 Vite 6，需要给 `vite.config.ts` 添加 ESM 支持或项目切换到 ESM。

---

## 九、后续待办

- [x] 修复渲染层空白窗口问题（3.5 + 3.6 节）✅
- [ ] 验证完整功能：新建文档、编辑、搜索、收藏、自动保存
- [ ] 验证打开外部 .md 文件 / 文件夹功能正常工作
- [x] 验证 `npm run build` + `electron-builder` 打包流程 ✅（win dir + zip，106MB）
- [x] ErrorBoundary 组件验证 ✅（`src/renderer/src/components/ErrorBoundary.tsx` 存在，`main.tsx` 已包裹）
- [x] 工作路径限定 ✅（所有操作严格在 `C:\Users\yaolin\WorkBuddy\2026-06-18-21-41-06\markflow` 下）
- [x] GitHub Actions CI/Release 合并为单一 ci.yml ✅（参考 md2html 的四阶段模式：test → auto-tag → build → release，删除独立的 release.yml）
  - CI 触发：push main + PR → test
  - Release 触发：push tag `v*` / `workflow_dispatch` → auto-tag → build（mac/Win/Linux）→ GH Release
  - 产物：dmg（mac）、zip+dir（win）、AppImage（linux）

---

## 十一、打包后渲染层路径错误（2026-06-20，已修复 ✅）

### 11.1 问题描述

用户在 `npm run dev` 正常，但打包后的 `release/win-unpacked/MarkFlow.exe` 出现以下错误：

```
Not allowed to load local resource: file:///D:/GitHub/markflow/release/win-unpacked/resources/dist/renderer/index.html
```

页面空白（无侧边栏），控制台报错：

```
bindings module not found: Error: Could not locate the bindings file.
```

### 11.2 根因分析

#### 问题一：`render_dist` 路径计算错误

**打包架构**：electron-builder 将 `dist-electron/index.js`（主进程）和 `dist/renderer/`（渲染进程）一起打包进 `app.asar`，位于 `resources/app.asar`。

**路径链**：

```
electron-builder 打包前：
  markflow/
  ├── dist-electron/
  │   └── index.js          # 主进程
  └── dist/
      └── renderer/
          └── index.html    # 渲染进程

打包后（asar 内部）：
  resources/
  └── app.asar/
      ├── dist-electron/
      │   └── index.js      # __dirname = ".../app.asar/dist-electron"
      └── dist/
          └── renderer/
              └── index.html
```

**原始错误代码**：

```typescript
export const MAIN_DIST = join(__dirname)                          // asar/dist-electron
export const RENDERER_DIST = join(MAIN_DIST, '../renderer/dist')  // asar/dist/renderer ✗ WRONG
// 或之前的版本：
export const RENDERER_DIST = join(__dirname, '../../dist/renderer') // path.join 规范化问题
```

`path.join()` 在 asar 虚拟文件系统中无法正确处理 `../` 跳转，且 `join(__dirname, '../renderer/dist')` 语义是"进入父目录后再找 renderer/dist"，而非"asar 内的 dist/renderer"。

**最终修复**：

```typescript
import { app } from 'electron'

// app.getAppPath() 返回 asar 路径（生产）或项目路径（开发）
export const MAIN_DIST = join(app.getAppPath(), 'dist-electron')
export const RENDERER_DIST = join(app.getAppPath(), 'dist', 'renderer')
```

- 生产：`app.getAppPath()` = `"D:\...\app.asar"` → `RENDERER_DIST` = `"D:\...\app.asar\dist\renderer"` ✅
- 开发：`app.getAppPath()` = `"D:\...\markflow"` → 同上，路径仍有效（Vite 构建产物在磁盘上）

#### 问题二：`loadFile()` 无法正确加载 asar 内路径

**错误代码**：

```typescript
mainWindow.loadFile(join(RENDERER_DIST, 'index.html'))
```

`loadFile()` 内部使用 `pathToFileURL` + `fs.readFile` 加载文件，但在 asar 虚拟文件系统中路径解析不正确。

**最终修复**：

```typescript
const indexPath = join(RENDERER_DIST, 'index.html')
mainWindow.loadURL(pathToFileURL(indexPath).href)
```

`loadURL(file://...)` 将路径转为标准 file:// URL 交给 Chromium 加载，Chromium 知道如何在 asar 内查找文件。

#### 问题三：`better-sqlite3` 的传递依赖缺失

**依赖链**：`better-sqlite3` → `bindings` → `file-uri-to-path`

打包时如果只包含 `better-sqlite3` 而不包含其传递依赖，`require('better-sqlite3')` 会失败。

**修复**：`electron-builder.json5`：

```json5
"files": [
  "dist-electron/**/*",
  "dist/renderer/**/*",
  "node_modules/better-sqlite3/**/*",
  "node_modules/bindings/**/*",
  "node_modules/file-uri-to-path/**/*",
  // ...
],
"asarUnpack": [
  "node_modules/better-sqlite3/**",
  "node_modules/bindings/**",
  "node_modules/file-uri-to-path/**"
],
```

### 11.3 涉及的改动文件

| 文件 | 改动 |
|------|------|
| `markflow/electron/main/index.ts` | `RENDERER_DIST`/`MAIN_DIST` 改用 `app.getAppPath()` 计算；`loadFile()` → `loadURL(pathToFileURL())` |
| `markflow/electron-builder.json5` | `files` 中加入 `dist/renderer/**/*`、`bindings`、`file-uri-to-path`；`asarUnpack` 修正 |

### 11.4 关键教训

1. **asar 内路径不要用 `path.join(__dirname, '../..')` 计算**：`path.join` 会规范化 `../` 跳转，在 asar 虚拟文件系统中导致路径越界
2. **`app.getAppPath()` 比 `__dirname` 更可靠**：它在 asar 内外都能返回正确的 asar 根路径
3. **`loadFile()` vs `loadURL()`**：asar 内优先用 `loadURL(pathToFileURL(...))`
4. **传递依赖必须显式打包**：`better-sqlite3` 的 `bindings`/`file-uri-to-path` 必须加入 `files` 和 `asarUnpack`
5. **workflow_dispatch 的 `inputs.dry_run` 可能为空**：当 `inputs.dry_run` 未勾选时 `${{ inputs.dry_run }}` 展开为 `null`，导致 shell 条件表达式报错

### 11.5 workflow_dispatch 触发 auto-tag 失败（2026-06-20 已修复 ✅）

#### 问题

通过 `workflow_dispatch` 触发 CI 时，`Determine Version` 步骤报 `Process completed with exit code 1`。

#### 根因

`if:` 条件表达式中 `!inputs.dry_run` 不被 GitHub Actions 布尔解析器支持。GitHub Actions 的 `if:` 中 `!` 不能作为前缀运算符反转布尔值。

#### 修复

将 `if: ... && !inputs.dry_run && ...` 改为 `if: ... && inputs.dry_run == false && ...`。

---

## 十二、妥协措施清理记录（2026-06-19）

根因（`ELECTRON_RUN_AS_NODE`）修复后，对项目做过的一系列妥协措施进行了系统审查和清理：

### 已撤销的妥协

| # | 妥协措施 | 处理结果 |
|---|---------|---------|
| 1 | `src/main/` 和 `src/preload/` 旧代码残留 | ✅ 删除（已迁移到 `electron/`） |
| 2 | `src/renderer/index.html` 重复 | ✅ 删除（用根目录的） |
| 3 | `scripts/` 目录里的 hack 脚本 | ✅ 删除（`prestart.js`、`postinstall.js`） |
| 4 | `@electron-toolkit/*` 4 个未使用的依赖 | ✅ 卸载（清理了 89 个包） |
| 5 | `eslint` 及相关 config（无配置文件） | ✅ 卸载 |
| 6 | `vite-plugin-electron-renderer`（未使用） | ✅ 卸载 |
| 7 | `tsconfig.json` 的 `@main/*` 路径指向旧目录 | ✅ 修正为 `electron/main/*` |
| 8 | `tsconfig.node.json` 的 include 指向旧目录 | ✅ 修正为 `electron/main` 和 `electron/preload` |
| 9 | `tsconfig.web.json` 的 `types: ["node"]`（渲染进程不需要） | ✅ 改为 `types: []` |
| 10 | `tailwind.config.js` 是 ESM，与 CJS 项目不一致 | ✅ 改为 `tailwind.config.cjs`（CJS 语法） |
| 11 | `electron-builder.json5` 的 `asarUnpack` 路径错误 | ✅ 修正为 `node_modules/better-sqlite3/**` |

### 保留的措施（非妥协，是正确做法）

| 措施 | 保留原因 |
|------|---------|
| `notBundle()` 插件 | native 模块（`better-sqlite3`）的 `.node` 二进制不能被 Rollup 打包，必须保持外部 require。测试证明移除后会报 `Could not dynamically require` 错误 |
| `vite.config.ts` 中的 `delete process.env.ELECTRON_RUN_AS_NODE` | 这是根因修复，必须保留 |
| `package.json` 无 `"type": "module"` | CJS 模式与 Electron 的 `require('electron')` 拦截配合最好，ESM 模式在 Electron 30 上有 named export 问题 |
| `postcss.config.cjs`（CJS 格式） | 项目是 CJS 模式，配置文件应统一为 CJS |
| `@electron/rebuild` + `postinstall` 脚本 | native 模块必须针对 Electron 版本重编译，这是标准做法 |
| `electron` 在 `devDependencies` | 提供类型声明和二进制，标准做法 |

### 清理效果

**依赖数量**：

- 清理前：`devDependencies` 有 19 个包
- 清理后：`devDependencies` 有 12 个包（减少 7 个直接依赖，89 个传递依赖）

**项目结构**：

- 清理前：`src/main/`、`src/preload/`、`src/renderer/index.html`、`scripts/` 都有残留
- 清理后：所有迁移残留清除，目录结构干净

**配置一致性**：

- 清理前：`tailwind.config.js`（ESM）+ `postcss.config.cjs`（CJS）混用
- 清理后：两个都是 `.cjs`，格式统一

**验证结果**：清理后 `npm run dev` 正常启动，Electron 窗口成功打开
