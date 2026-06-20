# MarkFlow — 快速启动参考

## 开发

```bash
cd markflow
npm install
npm run dev
```

## 打包

```bash
npm run package:win   # Windows NSIS 安装包
npm run package:mac   # macOS DMG
npm run package:all   # 两个平台都打
```

## 文件说明

| 文件/目录 | 用途 |
|---|---|
| `electron.vite.config.ts` | electron-vite 统一配置（main/preload/renderer） |
| `electron-builder.json5` | 打包配置（输出目录、图标、NSIS/DMG 设置） |
| `src/main/` | Electron 主进程 |
| `src/main/db/database.ts` | SQLite 初始化 + FTS5 迁移 |
| `src/main/ipc/documents.ts` | 文档 CRUD IPC 处理器 |
| `src/main/ipc/search.ts` | FTS5 全文搜索 IPC 处理器 |
| `src/preload/index.ts` | contextBridge 暴露 API |
| `src/renderer/src/` | React 渲染层 |
| `src/renderer/src/store/ui.ts` | Zustand UI 状态 |
| `src/renderer/src/hooks/useDocuments.ts` | TanStack Query 文档操作 |
| `src/renderer/src/hooks/useSearch.ts` | TanStack Query 搜索 |
| `src/renderer/src/components/editor/` | 编辑器 + 命令面板 |
| `src/renderer/src/components/sidebar/` | 文档侧边栏 |
| `src/renderer/src/components/preview/` | Markdown 预览 |
