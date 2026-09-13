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
- **SafeHtml / single sanitization gate** — the sole XSS boundary: rendered HTML passes through
  `SafeHtml` → `sanitizeHtml` (DOMPurify). Never bypassed (see `docs/adr/0002-single-sanitization-gate.md`).
- **appdoc:// protocol** — custom scheme for in-app document image / asset rewriting.

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

## Repo conventions

- **Create-PR Action** — in-repo GitHub Action (`actions/create-pr`) that idempotently creates/refreshes PRs;
  its bundled `dist/index.mjs` is **built at runtime** by `auto-pr.yml` from committed `src/` and is
  not committed (see `docs/adr/0005-committed-action-bundle.md`).
- **Coverage gate** — `npm run test:coverage` enforces 100% per-file on the unit-testable logic surface
  (see `docs/adr/0004-per-file-100-percent-coverage.md`).
- **ADR** — Architecture Decision Record, kept under `docs/adr/` (this file's sibling directory).
- **Issue tracker** — local markdown under `.scratch/<feature-slug>/` (see `docs/agents/issue-tracker.md`).
