# CONTEXT.md

Domain glossary for MarkFlow. Agents and humans should use these terms consistently when writing
issue titles, refactor proposals, tests, or docs. If a term you need isn't here, that's a signal to
either reconsider the invented wording or flag it for `/domain-modeling`.

MarkFlow is a cross-platform Markdown editor with a Linear-style UI, built with Electron 43 +
React 19 + TypeScript 7 (strict) + Tailwind CSS 4, packaged via electron-builder.

## Documents & editing

- **Document** — a Markdown file (`.md` / `.mdx`) loaded into the app. Carries `content`, `filePath`,
  `encoding`, `wordCount`, `createdAt`, `updatedAt`, and derived `title`.
- **Draft (in-memory document)** — a newly created document that lives entirely in memory until
  explicitly saved. Its first **Save** opens **Save As** to choose a path; nothing is ever written to a
  hidden default location.
- **Memory-only document** — a draft created via `documents:create` with `memoryOnly: true`: no file is
  written and no watcher is attached; the store holds a row with `file_path = ''` and the UI marks it
  `isNewUnsaved`. The sidebar lists such docs in a dedicated **"Unsaved drafts"** group (they have no path
  to place in the folder tree). Drafts are never persisted across app restarts.
- **.mdx handling** — `.mdx` files open, list, and preview like regular Markdown (extension shown in the
  sidebar). JSX / embedded components are **not** parsed (true MDX compilation is a deferred RFC); `.mdx` is
  currently treated as plain Markdown.
- **Read-only by default** — files open read-only to prevent accidental edits; toggle to Edit mode anytime.
- **Renaming is a file operation, not an edit** — renaming from the sidebar is an inline, immediate on-disk
  move (`documents:rename-file`): it does **not** require Edit mode, does not switch the document into edit
  mode, and needs no save. It works on any listed file, not just the open one. (The **title bar /
  breadcrumb** rename still goes through Edit mode, unchanged.)
- **File names & extensions** — the inline name input shows the **full file name including the extension**,
  and the typed extension is the one that lands on disk: a supported Markdown extension (`.md` / `.markdown`
  / `.mdx` / `.mdtxt` / `.mdtext`) is used as typed; a name with **no extension** gets `.md` appended but the
  commit is **held** until a second Enter; anything else (e.g. `.txt`) is **refused** — nothing is written
  and the `.md` spelling is offered back in the input. Path separators are refused too (folded to `-`) so a
  rename cannot escape the folder. A name that **already exists** is likewise refused: flagged live (red
  border, Enter blocked) and rejected by the main process with `EEXIST` instead of being renumbered to `-1`
  or silently overwritten — and the comparison is case-insensitive off Linux. See
  `docs/adr/0011-file-name-and-extension-rules.md`.
- **Manual save** — no auto-save. **Save** (`Ctrl/Cmd+S`), **Save As…** (`Ctrl/Cmd+Shift+S`), and
  **Reload from Disk** (`Ctrl/Cmd+Shift+R`).
- **Split-pane / preview mode** — view modes: edit, preview, or split (editor + live preview side by side
  with a draggable divider).
- **Synchronized scrolling** — in split view, source and preview panes scroll in lockstep by scroll ratio.
- **.mdx support** — `.mdx` files open, list, and preview like regular Markdown (extension shown in sidebar).

## Navigation & workspace

- **Workspace** — the currently open folder plus its loaded documents (tracked via `openFolders`).
  **Close workspace** returns to an empty state; **Close file** keeps the folder + sidebar.
- **Active Folder** — the folder whose file tree is shown in the sidebar; renderer-side UI state in the
  Zustand `ui` store.
- **Sidebar** — collapsible nested folder tree listing Markdown files; file names include their extension
  and subfolders start collapsed.
- **File path breadcrumb** — current file path shown above the editor; folder icon reveals it in the system
  file manager.
- **Open anywhere** — launch via CLI, drag-and-drop, or as the default app for `.md`. App starts fresh
  (no previous file/folder restored); window size is not persisted.
- **Markdown-bearing folder (含 Markdown 的文件夹)** — a folder containing a Markdown document in itself or
  any descendant (transitive containment). The sidebar shows only these by default; this matches `main`'s
  pre-feature behavior.
  _Avoid_: "folder with md"
- **Document-less folder / empty branch (不含文档的文件夹 / 空文件夹)** — a folder (and its subtree) that
  contains no Markdown document anywhere. Hidden by default; revealed only when **显示所有文件夹** is ON or
  when it is a **recently-created folder**. "Empty" means no Markdown, not necessarily zero subfolders.
  _Avoid_: "empty folder" (imprecise — may contain subfolders)
- **Recently-created folder (最近新建文件夹)** — a folder made this session and held in the in-memory
  `recentlyCreated` set; force-shown even when **显示所有文件夹** is OFF, until it gains its first Markdown
  document or the app restarts.
  _Avoid_: "new folder"
- **显示所有文件夹 (show all folders)** — the opt-in sidebar toggle (default OFF) that reveals
  document-less folders by seeding `buildFileTree` with the on-disk directory listing. One source of truth
  (`useUIStore.showAllFolders`) shared by the toolbar button and the background-context-menu checkbox;
  in-memory only, never persisted. See `docs/adr/0010-sidebar-folder-filter-toggle.md`.
  _Avoid_: "show empty folders" (a valid checkbox synonym, but the canonical toggle name is 显示所有文件夹)

## Storage & search (main process)

- **Document Store** — the in-memory `Map` (`electron/main/model/documentStore.ts`) holding loaded documents;
  the single source of truth in the main process. Replaced the old SQLite `:memory:` layer (see
  `docs/adr/0001-disk-driven-document-model.md`).
- **minisearch index** — pure-JS full-text search (`electron/main/ipc/search.ts`), rebuilt per query,
  powering the Command Palette. No native dependency.
- **folderWatcher (chokidar)** — recursive watcher over `openFolders` that syncs disk changes into the
  store; ignores non-Markdown and build output (`**/*.html`, `**/*.pdf`, `**/*.docx`, `**/*.tmp`).
- **Markdown dual-write** — Markdown files are written to disk; there is no separate index file.
- **Full-text search** — minisearch-powered, instant results with highlighted snippets.

## Search & find

- **Find widget (就地查找条)** — an in-place find UI that overlays the content it searches; never a layout
  row. Owned by the **editor** (find + replace) and the **preview** (find only). Carries the
  **match-case (`Aa`)**, **whole-word (`ab`)**, **regex (`.*`)** and **preserve-case (`AB`)** toggles.
  _Avoid_: "search panel" when you mean this.
- **Search panel (搜索面板)** — the cross-document search surface that lists matching documents. It
  navigates between documents rather than overlaying one.
  _Avoid_: "find bar" when you mean this.
- **Content mode (正文模式)** — the search mode that matches a document's `title`, `content` and
  `folderPath`.
- **Filename mode (文件名模式)** — the search mode that matches the **file name** only; by default the
  path and the extension are ignored.
- **File name (文件名)** — `basename(filePath)`, **including** the extension (e.g. `notes.md`).
- **Document title (`title`)** — the document's derived, **extension-less** file name (e.g. `notes`); what
  the sidebar shows. _Avoid_: using "file name" to mean `title`.
- **Glob pattern (通配符)** — a file-name pattern in VS Code's glob syntax (`/`, `*`, `?`, `**`, `{}`,
  `[]`, `[!]`). In **filename mode** a query containing a glob metacharacter switches from plain file-name
  matching to glob matching; a pattern without `/` matches the file name at any depth, one with `/` matches
  the path relative to the open folder.

## Rendering & security

- **Markdown pipeline** — `src/renderer/src/lib/markdownPipeline.ts` + `sanitize.ts`, producing sanitized
  HTML from GFM + KaTeX + Mermaid + GitHub Alerts + custom containers.
- **single sanitization gate（单点净化门）** — the sole XSS boundary: `sanitizeHtml()` (DOMPurify) is the only
  producer of the branded `SanitizedHtml` type, and `patchPreviewContent()` (`previewRender.ts`) is the only
  DOM write entry that accepts it — an unsanitized string cannot compile. Never bypassed
  (see `docs/adr/0002-single-sanitization-gate.md`).
- **internal markers（内部标记）** — attributes the pipeline injects for its own bookkeeping; must be stripped
  when content leaves the app (rich-text copy): `data-line` (source-line mapping), `data-mermaid-slot`
  (mermaid placeholder index), `data-lang` (fence language), `data-baked` (runtime-mutated node, e.g. the
  image-error placeholder). _Removed in plan-03 / plan-02 D9_: `data-mermaid-source` — the "Copy diagram
  source" menu was deleted in plan-02 D3, so the mermaid source now lives only in the renderer's per-parse
  mermaid slot, never the DOM.
- **github-markdown-css（单一 Markdown 样式源）** — the preview and the exporter share the same
  `github-markdown-css` stylesheet (injected at runtime for the preview, inlined for export), so
  preview == export == print (WYSIWYG). Replaced the hand-rolled Tailwind Typography `.prose` rules in
  plan-03 §4.1.
- **lazy mermaid render（Mermaid 懒渲染）** — mermaid diagrams render in the DOM after the incremental patch,
  via IntersectionObserver + a content-hash SVG cache, instead of being baked into the HTML string. Avoids the
  ~2.5s first-paint regression and keeps re-parses from re-rendering unchanged diagrams (plan-03 §4.3).
- **complete bake（导出补齐烘焙）** — export / print / rich-text copy render **every** mermaid
  diagram into the canonical HTML before building their output, instead of reusing the
  preview's lazily-rendered DOM. The preview is allowed to be partial (viewport-driven); an
  output artifact is not. Shares the lazy path's content-hash cache, so a diagram the preview
  already rendered is never rendered again. ADR 0019.
- **intrinsic image dimensions（图片固有尺寸）** — local `appdoc://` images get `width`/`height` from
  `image-size` (main process, header-only, cached by path) before sanitize/patch, so the browser reserves
  space and the first paint doesn't jump (CLS). See plan-03 §4.4 / R9.
- **appdoc:// protocol** — custom scheme for in-app document image / asset rewriting. The sanitize gate
  explicitly whitelists it (`ALLOWED_URI_REGEXP`), otherwise DOMPurify would strip the `src`.
- **Formula（公式）** — one KaTeX-rendered math node in the preview, inline or display: the unit the UI
  treats as a single object (what a right-click targets, what a copy carries). _Avoid_: "equation"
  (a meaning inside the math), "math block" (that is the layout, not the object). See ADR-0020.
- **Carrier（承载物）** — the form a piece of content takes once it is on the clipboard. A formula
  rides its **MathML carrier** (text, which Word / OneNote turn into an editable equation) or its
  **bitmap carrier** (a PNG). A target app reads whichever carrier it understands, and one clipboard
  cannot distinguish targets. _Avoid_: "format" (that is the MIME type, not the content form).

## Theme & appearance

- **Theme mode** — `useUIStore.theme` is `'light' | 'dark' | 'system'`
  (`src/renderer/src/types/index.ts`). The Markdown **preview** follows it: `MarkdownPreview.tsx` resolves
  `isDark` from `theme`, or from `matchMedia('(prefers-color-scheme: dark)')` when `theme === 'system'`, and
  sets `data-theme` on the `<article>`; the **exporter** follows it too (`export.ts` resolves `current` → UI
  theme, `system` → `matchMedia`). See `docs/adr/0018-preview-refactor-03-style-perf-media.md`.
- **No UI theme toggle** — `setTheme` exists in the store and as `window.api.app.setTheme` (preload IPC), but
  **no user-facing control invokes it**; the store default is `'light'`, so the app renders light unless
  changed programmatically. The app **chrome** applies
  `document.documentElement.classList.toggle('dark', …)` only when `theme === 'dark'` — it does **not** track
  `system`. So: preview/export honor the theme, the chrome does not follow the OS `system` preference, and there
  is no user switch. This is a pre-existing theme-sync gap, out of scope for `plan-03` (D-B only unifies the
  preview's style source to github-markdown-css; it does not add a toggle). _Avoid_: assuming the app ships a
  clickable dark-mode switch.

## Platform & filesystem

- **case-sensitive filesystem**: a filesystem on which `Note.md` and `note.md` are two distinct files.
  In MarkFlow (following VS Code's rule) only Linux is case-sensitive; Windows and macOS fold names
  case-insensitively, so the two spellings name the same file. Modeled by the shared pure rule in
  `shared/fileUtils.ts` (`arePathsSame` / `foldName` / `MD_EXTS`) and detected per process by `isFileSystemCaseSensitive`
  (main) / `pathCaseSensitive` (renderer). See ADR-0014.
- **platform seam**: the single injectable point at which a process detects an environment fact
  (e.g. `isFileSystemCaseSensitive` in `electron/main/lib/disk-io.ts`, `pathCaseSensitive` in the
  renderer) so environment-dependent rules can be unit-tested deterministically without faking
  globals. The pure rule consumes the detected boolean rather than reading `process.platform` /
  `navigator` itself. See ADR-0014.

## App behavior, dialogs & UI

- **No persisted settings (禁止持久化任何设置项)** — no UI setting (any toggle, search mode, window or
  layout state) is written to disk or `localStorage`; every launch starts from clean defaults. The one
  pre-existing exception in the codebase is the UI language. New toggles must **never** be persisted.
  See `docs/adr/0010-sidebar-folder-filter-toggle.md`.
- **dialog:confirm (app-modal)** — the only sanctioned way to prompt for unsaved-change discard and similar
  yes/no questions. It is a `dialog:confirm` IPC backed by `dialog.showMessageBox` (an app-modal dialog that
  returns focus to the window on close). Native `window.confirm` is **forbidden** for these prompts: it fires
  a WIN-BLUR on Windows that leaves the editor untypeable (see `docs/adr/0009-app-modal-dialogs.md`).
- **tryCloseWorkspace (unified quit path)** — closing a file, closing the workspace, and quitting the app all
  run the same `tryCloseWorkspace()` logic (same unsaved-change prompt, same `app:quit-allowed` →
  `before-quit` → `app.quit()` flow). New documents and existing unsaved edits are treated identically.
- **Context menu (right-click)** — right-click menus use `@radix-ui/react-context-menu` (pops at the cursor,
  native Shift+F10); button-triggered dropdowns use `@radix-ui/react-dropdown-menu`. Menu items stop event
  propagation to avoid firing ancestor handlers. See `docs/adr/0008-context-menu-architecture.md`.
- **formatShortcut** — renders a keyboard shortcut string per platform (⌘ on macOS, Ctrl elsewhere); tooltip
  and menu shortcuts must use it rather than a hardcoded `⌘`.
- **AUTO-block PR body** — the Create-PR Action manages PR bodies via symmetric `<!-- AUTO:key --> … <!-- /AUTO:key -->`
  markers; on refresh each segment resets to the template while human-written content outside the markers is
  preserved. (A planned generalization replaces the hardcoded blocks with scanned `.mjs` **block plugins** —
  designed but not yet implemented.) See `docs/adr/0005-committed-action-bundle.md`.
- **TypeScript 7 + ESLint TS6 shim** — the app builds on TS7 while `typescript-eslint` v8 still needs TS6 for
  the linter; `scripts/install-eslint-ts6.mjs` installs the TS6 checker side-by-side purely for lint. A
  documented transitional measure. See `docs/adr/0007-typescript7-eslint-ts6-shim.md`.

## App architecture

- **IPC** — main↔renderer messaging: `documents`, `search`, `export`, `app`, `dialog`, `window`, `menu`,
  `events`.
- **preload / contextBridge** — `electron/preload/` exposes a typed `window.api`.
- **TanStack Query** — renderer-side wrapper over IPC calls (`useDocuments`, `useSearch`).
- **Zustand** — UI state store (`src/renderer/src/store/ui.ts`).
- **i18n** — internationalization with locale detection/storage, decomposed into `storage.ts` + `useT.ts`
  (no circular dependency with the UI store; see `docs/adr/0003-main-process-entry-decomposition.md`).

## Build & output

- **Bundler output** — the intermediate artifacts produced by the bundler (Vite + `vite-plugin-electron`) before packaging; everything lands under one `dist/` root: `dist/renderer/` (web UI) and `dist/electron/` (main process `index.js` + `preload.cjs`). _Avoid_: treating anything under `dist/` as the product. See `docs/adr/0015-build-output-layout-and-bundle.md`.
- **Packaged output** — the final, shippable application produced by electron-builder (`electron-builder.json5`); it lives in `release/` (e.g. `release/win-unpacked/MarkFlow.exe`). This is "the product", distinct from the `dist/` bundler output; the `afterAllArtifactBuild` hook prints its location when packaging finishes.
- **`asar`** — Electron's archive format bundling the app payload into one read-only file (`resources/app.asar`). Enabled by default in electron-builder (`asar: true`); `compression: 'maximum'` is a separate root-level option that compresses the _packaged archive_ (zip/dmg/AppImage), not the asar.
- **Lazy-load (dynamic import)** — loading a module on first use via `import()` instead of a top-level `import`. Used for `mermaid` (renderer first paint) and `franc` (export path).
- **Vendor chunk** — a build chunk holding third-party `node_modules` code, named `vendor-<pkg>` by the policy in `scripts/vendor-chunks.ts`. Splitting per package (plus a few grouped families such as mermaid and the CodeMirror/lezer editor stack) keeps each chunk independently cacheable and under the build's `chunkSizeWarningLimit`.
- **Synchronous render constraint** — markdown-it's `highlight` callback and the `texmath` engine call `highlight.js` / `katex` synchronously during `md.render()`, so lazy-loading those two requires rewriting the render pipeline. They stay eager — and are still `modulepreload`ed, because `parseClient.ts` statically imports the pipeline as its main-thread fallback for when the Worker fails. See `docs/adr/0015-build-output-layout-and-bundle.md`.
- **Font formats** — `.woff2` is the modern, smallest web font format supported by Electron/Chromium. KaTeX also ships `.woff` / `.ttf` for legacy browsers; `scripts/prune-fonts.ts` prunes those because KaTeX's CSS lists `.woff2` first, so the legacy copies are never requested.
- **Fully bundled** — both the main process (`dist/electron/index.js`, no bare `require()` except Node builtins) and the renderer are self-contained Vite outputs, so the packaged app ships **no `node_modules`** (`electron-builder.json5` excludes them). Consequence: a dependency that is _read at runtime_ instead of being bundled works in dev and fails only in the packaged build — sign off dependency changes by running `npm run dist` and launching `release/win-unpacked/MarkFlow.exe`. See `docs/adr/0015-build-output-layout-and-bundle.md`.
- **Electron runtime floor** — the ~180 MB Chromium + Node payload every Electron app carries regardless of app-code size. The dominant component of `MarkFlow.exe`; it cannot be reduced without changing frameworks (e.g. Tauri). Measured: 367 MB for Electron 44 (`electron.exe` alone is 235 MB).

## Repo conventions

- **Create-PR Action** — in-repo GitHub Action (`actions/create-pr`) that idempotently creates/refreshes PRs;
  its bundled `dist/index.mjs` is **built at runtime** by `auto-pr.yml` from committed `src/` and is
  not committed (see `docs/adr/0005-committed-action-bundle.md`).
- **Type-of-Change taxonomy (create-pr)** — the PR template's `{{types}}` block renders seven self-ticking
  checkboxes: `Bug fix`, `New feature`, `Refactor`, `Tests`, `Performance / technical improvement`
  (one `improvement` flag aggregating the `perf`/`ci`/`build`/`chore` branch prefixes), `Documentation
update`, and a `Breaking change` **overlay** that can sit on any work-type box. The taxonomy is owned
  by the repo-side `types` plugin, which derives the flags itself from `ctx.head` + `ctx.services.git`
  via `classifyChange`; the render core never computes a `typeFlags` field. See
  `docs/adr/0021-pr-type-of-change-follows-branch-taxonomy.md` and the unified core↔plugin contract in
  `docs/adr/0022-plugin-context-and-service-injection.md`.
- **PluginContext (create-pr)** — the single `ctx` object passed to every block plugin: `{ head, base,
title, services }`. `services` is the set of injectable I/O capabilities (`git`/`gh`/`templateSource`)
  the plugin pulls data from; the renderer/middleware never pre-computes domain facts (PR type, linked
  issue) — plugins own those. See `docs/adr/0022-plugin-context-and-service-injection.md`.
- **plugin-autonomy (create-pr)** — block plugins fetch the data they need (e.g. `git log`, linked issue)
  from `ctx.services` themselves rather than receiving pre-computed fields; `services.git` is memoized at
  the injection boundary so multiple plugins calling it cost at most one real git spawn.
- **Coverage gate** — `npm run test:coverage` enforces 100% per-file on the unit-testable logic surface
  (see `docs/adr/0004-per-file-100-percent-coverage.md`).
- **ADR** — Architecture Decision Record, kept under `docs/adr/` (this file's sibling directory).
- **Issue tracker** — local markdown under `.scratch/<feature-slug>/` (see `docs/agents/issue-tracker.md`).
