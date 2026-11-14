# CONTEXT.md

Domain glossary for MarkFlow. Agents and humans should use these terms consistently when writing
issue titles, refactor proposals, tests, or docs. If a term you need isn't here, that's a signal to
either reconsider the invented wording or flag it for `/domain-modeling`.

MarkFlow is a cross-platform Markdown editor with a Linear-style UI, built with Electron 44 +
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
- **New Draft vs New File…** — two distinct create actions, deliberately not duplicates. **New Draft**
  (`Ctrl/Cmd+N`, global toolbar, editor empty state) is filesystem-independent: it opens a memory-only draft
  with no dialog and only **one** may exist at a time (every entry point disables itself while one is alive,
  ADR-0006). **New File…** (File menu, sidebar `+`, sidebar context menus) is filesystem-bound: it names and
  writes a real Markdown file into the **open folder**, so it is unavailable with no folder open, and it
  resolves the typed name through `resolveNewFileTarget` (ADR-0011).
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

- **Workspace** — the single opened root folder plus its loaded documents, tracked via **`workspaceRoot`**
  (ADR-0023), which is also the **single** directory the file watcher covers.
  Opening a folder **replaces** the workspace. **Close workspace** returns to an empty state; **Close file**
  keeps the folder + sidebar.
- **Active folder (当前文件夹)** — the folder whose file tree is shown in the sidebar; renderer-side UI
  state in the Zustand `ui` store, set when you drill into a subfolder. It is **not** the workspace root and
  **never affects search scope** — glob and relative paths are resolved against **`workspaceRoot`** (ADR-0023
  decisions 2–3). It stays `null` only for an empty workspace. _Avoid_: conflating with **Opened root folder**
  / `workspaceRoot`.
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

## UI surfaces

- **Quick Open (⌘⇧K)** — the global-bar command that opens a document by name/path (Goto File). Its
  ⌘⇧K shortcut (Ctrl+Shift+K on Windows/Linux) is surfaced through the button's Tooltip / aria-label.
  It is **not** a persistent chip on the toolbar: the design diagram (fig 02) shows the shortcut only
  as a Tooltip example, so there is no always-visible shortcut chip element. Relocated from ⌘K to
  ⌘⇧K so that ⌘K could become the mainstream Link shortcut — see
  `docs/adr/0032-format-toolbar-shortcuts-and-precedence.md`.
- **Tooltip** — the popover shown on hover/focus for icon-only controls. It carries the control's full
  name and any keyboard shortcut. Its bubble is the theme's text colour with the theme's background as
  text, and has no visible border (border colour equals the fill).
- **Activity bar** — the always-present ~48px vertical icon column at the left of the sidebar (Files /
  Search switch). It is **permanent**: collapsing the sidebar (⌘\) hides only the content panel, never
  the activity bar.
- **Content panel** — the sidebar region (file tree or search) that sits to the right of the activity
  bar and unmounts when the sidebar is collapsed.
- **Global bar** — the single toolbar mounted above the content area in every view mode (Quick Open,
  save, file details, close, the source/split/preview switch, title + path). It carries **no sidebar
  toggle**: the content panel is folded from the **活动栏 (Activity bar)** right-click menu, the native
  **视图** menu, or ⌘\.
- **Editor pane bar** — the per-pane toolbar attached to the editor pane, holding the editor-only
  clusters (Markdown formatting, find/replace, undo/redo, read-only toggle). One per column in split
  mode. As the column narrows, commands move into the **conditional overflow trigger** one at a
  time by descending priority (the priority+ pattern in `components/ui/priority-overflow.ts`): the
  leftmost formatting cluster survives the longest, and at/above `ALL_INLINE_AT` (472px) there is no
  overflow at all. Every overflow entry carries a visible label — there is no separate unlabeled
  "Format" dropdown. See `docs/adr/0031-ui-round-3-shortcuts-overflow-and-menu.md`.
- **Preview pane bar** — the per-pane toolbar attached to the preview pane (find, export HTML, copy,
  copy rendered HTML). Copy rendered HTML is the lowest-priority command. As the column narrows,
  commands move into the **conditional overflow trigger** one at a time, rightmost first; when every
  command fits there is no trigger and all commands are inline.
- **Conditional overflow trigger** — the **"…"** button on a pane bar. It exists only while at least
  one command cannot be shown inline; when all commands fit, all of them are inline and the trigger
  is absent. It is **not** a resident menu, and no command may have it as its only access path.
  Overflow entries keep the bar's priority order and carry a visible label. The trigger itself
  occupies one command slot, so the final widening step restores the last command _and_ removes the
  trigger together: no width exists for "all but one inline, plus the trigger".
  Each bar budgets its **own** chrome: the editor bar pays the shared `px-3` padding plus its
  format-group border and find/replace divider (40px, so its twelve commands are all inline from
  472px), while the preview bar has no separators and pays padding only (24px, so its four commands
  fit from 168px). Charging both bars the same budget made the preview overflow 16px too early.

## Editor state

- **Undo history (撤销历史)** — the CodeMirror `history` state field inside the single persistent
  `EditorView`. It belongs to an **editing session**, not to a document record: switching or closing
  a document, and reloading the same document from disk, each discard the old field and create a new
  empty one. Therefore an edit made before a switch cannot be undone after switching back, even if
  it was saved. This is a deliberate consequence of the single-active-document model, unlike VS
  Code's per-resource edit stacks. _Avoid_: "per-document undo stack", "undo history is preserved
  across switches". _See also_: **Unsaved-changes guard**, **Editing session**.
- **Editing session (编辑会话)** — one session per open document, owning the editor's debounced
  preview refresh and the **right to write**: it remembers the text it last wrote into the view, and
  a keystroke is committed only while it was applied to exactly that text. A switch aborts the
  previous session (cancelling its pending timer) and the new session owns nothing until the new
  document's content has been written, so neither a late refresh nor a keystroke in that window can
  write the previous document's text into the new one. Correctness state — the unsaved text, the
  dirty flag and the **Dirty buffer snapshot** — is committed on the keystroke frame, never by the
  debounce; the debounce only refreshes the preview. _See also_:
  `docs/adr/0033-editor-draft-session-isolation.md`.
- **Unsaved buffer registry (未保存缓冲区登记表)** — the renderer's `Record<docId, { content,
revision }>` of unsaved text. The main process only knows on-disk bytes, so content search and
  cross-file replace need the renderer to report these buffers. The key is a **document id** used
  for addressing, never for deciding whether a callback is stale. _See also_:
  **Dirty buffer snapshot**, **Unsaved-changes guard**.

## Storage & search (main process)

- **Document Store** — the in-memory `Map` (`electron/main/model/documentStore.ts`) holding loaded documents;
  the single source of truth in the main process. Replaced the old SQLite `:memory:` layer (see
  `docs/adr/0001-disk-driven-document-model.md`).
- **Index-free search scanner** — a search approach that scans document bodies on every query and
  keeps no persistent index. Its candidate set is exactly the set of literal body hits; display
  counts, hit offsets and every replacement come from one shared matcher, and results are ordered
  deterministically by root-relative path with no relevance score. **Quick Open** (file names /
  paths) does not use it. _Avoid_: "search engine" (a superseded design, not a current component).
  _See also_: **Full-text search**, **Literal phrase query**.
- **folderWatcher (chokidar)** — recursive watcher over the single `workspaceRoot` that syncs disk changes
  into the store; ignores non-Markdown and build output (`**/*.html`, `**/*.pdf`, `**/*.docx`, `**/*.tmp`).
- **Markdown dual-write** — Markdown files are written to disk; there is no separate index file.
- **Full-text search** — instant cross-document search. The **Search view** groups results per file and
  renders **hit rows** carrying bounded hit context (line number + offsets + a short excerpt), never the
  full document body (see **Bounded hit context**); **Quick Open** presents a flat **file name + relative
  path** list only. Body matching is a **literal phrase** match (see **Literal phrase query**) and
  includes open documents' **unsaved buffers** (see **Dirty buffer snapshot**).
- **Literal phrase query (完整字面短语)** — a body query matched as **one literal string**: spaces belong
  to the query, nothing is split into words, and there is no implicit AND/OR. `Machine Learning`
  matches only that consecutive phrase, never a file that merely contains both words. The same matcher
  serves display counts, hit offsets and every replace action, so "4 hits shown" and "4 replacements
  written" cannot diverge. _Avoid_: "word search", "multi-term query". _See also_: **Full-text search**.
- **Dirty buffer snapshot (脏缓冲区快照)** — the renderer's current text for every open **unsaved**
  document, sent with a content query (`dirtyDocumentSnapshots`) together with a monotonic
  `documentStateRevision`. It exists because the main process only knows the on-disk bytes, so without
  the snapshot a document with unsaved edits would be searched (and skipped by replace) from a stale
  version. Replace plans and applies carry the same snapshot plus `unsavedDocumentIds`; an apply whose
  revision no longer matches is cancelled before any write. _See also_: **Unsaved-changes guard**.

## Search & find

- **Find widget (就地查找条)** — an in-place find UI that overlays the content it searches; never a layout
  row. Owned by the **editor** (find + replace) and the **preview** (find only). Carries the
  **match-case (`Aa`)**, **whole-word (`ab`)**, **regex (`.*`)** and **preserve-case (`AB`)** toggles.
  _Avoid_: "search panel" when you mean this.
- **Search panel (搜索面板)** — the cross-document search surface that lists matching documents and
  navigates between them (rather than overlaying one). It now has **two specialized instances that no
  longer share one component**: the `Ctrl/Cmd+K` **Quick Open** palette (file **names / paths** only,
  flat list) and the sidebar **Search view** (Markdown **body content** only, with scope + replace).
  See **Quick Open** and **Search view**. The old "one `SearchPanel` shared by both" design was
  superseded by `docs/adr/0023-search-scope-and-specialized-surfaces.md`.
  _Avoid_: "find bar" when you mean this.
  Note: unlike the Find widget, the Search view is **literal-match based by default** — the
  **Match Case (`Aa`)** toggle (default off — ADR-0023) plus the **opt-in regex (`.*`)** and
  **whole word (`ab`)** toggles (both default off, ADR-0023's 2026-10-17 revision). In regex
  mode `\n` matches a line break (CRLF included); a real newline typed into the query is still
  refused (single-line input).
- **Search view (搜索视图)** — the sidebar surface for cross-document **body-content** search, scope
  (include/exclude), and cross-file replace. It is **mutually exclusive with the File view** (File
  view shows the tree; Search view shows the search box, scope, and results — never both), replacing
  the old "resident panel above the tree" design. It is the only surface that renders per-file **hit
  rows** and the replace controls; the `Ctrl/Cmd+K` Quick Open stays a flat list for quick jumps. Its
  collapsed state is session-only (see **No persisted settings**). The UI label reads "Search in
  files". Content-only, scope, and replace are settled by
  `docs/adr/0023-search-scope-and-specialized-surfaces.md` (supersedes the earlier _Planned_ note).
  _Avoid_: "search panel" when you mean this specific sidebar surface; "find bar" entirely.

- **Quick Open (快速打开 / Go to File)** — the `Ctrl/Cmd+K` palette that locates a document by **file
  name or relative path** only (flat list, no scope, no replace). It is the file-name half of the
  specialized search split (ADR-0023); the sidebar Search view owns body content. Its only visible
  entry is the **Command centre** trigger in the **global toolbar**.
- **Global toolbar (全局工具栏)** — the app's always-present tool row at the top of the **editor
  pane** (`GlobalToolbar.tsx`), rendered both with and without an active document. It
  hosts the **Command centre** trigger and the document-lifecycle actions (save / save-as / reload /
  file details / export / close) — as opposed to the editor-only clusters, which live in the
  **editor pane bar**. **It is not a separate top bar**: adding one was
  rejected (ADR-0023 decision 7), so the dead `ui/titlebar.tsx` is deleted rather than revived.
  _Avoid_: "title bar" / "顶栏" for this — MarkFlow has no dedicated title bar component.
- **Hit row (命中行)** — one in-document occurrence row inside a search group, carrying the line
  number plus the **document-wide character offsets** of the match, so it can place the editor
  cursor there.
- **Bounded hit context (有界命中上下文)** — the capped match list returned **instead of** a body
  snippet (≤ `MAX_MATCHES_PER_DOC` per document, ≤ `MAX_RESULT_DOCS` documents), each entry being a
  line number, the match offsets and a short excerpt. Returning only this keeps document bodies out
  of the UI and the clipboard (data minimization).
- **Content mode (正文模式)** — the Search view's body-content search: it matches a document's
  `content` field **only** (the `title` and `folderPath` no longer contribute — ADR-0023 decision 4 makes
  the candidate set content-only; memory-only **drafts** are excluded once any scope pattern is set). The
  hit line shows a matched snippet from the body and a line number.
  _Avoid_: "filename mode" — that is now Quick Open's job, not a mode of the Search view.
  _See also_: **Quick Open**, **Search view**.
- **Filename mode (文件名模式)** — file-name matching (the historical mode): it matches the **file
  name** only; by default the path and the extension are ignored. It is now the responsibility of
  **Quick Open** (`Ctrl/Cmd+K`), not a mode of the sidebar Search view (ADR-0023). The glob behavior is
  unchanged. _Avoid_: conflating it with the body-content Search view. _See also_: **Quick Open**.
- **Whole word (`ab`)** — a match counts only when the query forms a **complete word**, judged against
  **Unicode word boundaries** rather than an ASCII letter/digit boundary. Segmentation follows the
  text's **script** (independent of locale), so the toggle is meaningful for Chinese and Japanese as
  well as Latin. It belongs to the **Find widget** toggle set **and the Search view** (`ab`, both
  implemented — ADR-0023's 2026-10-17 revision). _Avoid_: assuming it is a no-op for CJK — on
  a full-ICU runtime `中文` matches inside `这是中文文本` while `文文` does not.
- **Opened root folder (打开的根文件夹)** — the single folder the user opened; the only root of the
  workspace. Distinct from the **active folder**: drilling into a subfolder in the sidebar changes the
  active folder, **not** the root. Search **scope** patterns are always resolved against this root.
- **Search scope (搜索范围)** — the pair of visible, editable path patterns (`include` / `exclude`)
  that delimit a cross-document search; **empty means the whole opened root folder**. It is expressed
  as text, never as a mode toggle, so what is being searched is always on screen. An invalid pattern
  blocks the search rather than being ignored (see **Invalid pattern**). See
  `docs/adr/0023-search-scope-and-specialized-surfaces.md`.
- **Include / Exclude pattern (包含 / 排除规则)** — a comma-separated list of patterns resolved
  against the **opened root folder**. The list is split with a **glob-aware** tokenizer (commas
  inside `{}` or `[]` do not split, so `*.{md,mdx},./docs` is two patterns and `[ab,c].md` is one).
  Each pattern is then **classified** before matching — see **Path-type pattern** and **Glob
  expression**. Excluded wins over included. An **invalid** pattern blocks the whole query and the
  whole replace plan (nothing is silently dropped): see **Invalid pattern**. _Planned:_ see the plan
  named below; not yet implemented.
- **Path-type pattern (路径型 pattern)** — a scope pattern that names a **place**: an absolute path,
  or one starting with `./`, `../`, `.\`, `..\`. It is matched twice — as written and as
  `pattern + '/**'` — so `./work` selects that folder and everything under it, and only at that
  position under the root (VS Code's `isSearchPath`, `queryBuilder.ts:362-364`).
- **Glob expression (glob 表达式)** — a scope pattern that names a **shape** rather than a place
  (e.g. `*.md`, `**/*.md`, `*.{md,mdx}`). It is matched as `**/pattern/**` and `**/pattern`, so a
  bare `docs` matches that folder at any depth and `*.md` matches `a/b.md` — a blanket
  `pattern + '/**'` would miss both. _Avoid_: applying the path-type double candidate to a glob.
- **Invalid pattern (无效 pattern)** — a scope pattern that cannot be parsed (unbalanced `[`/`{`, a
  stray `}`). It **blocks** both search and replace: the query returns a blocking diagnostic naming
  the field and the pattern and clears previous results, and the replace plan fails with zero
  writes. Dropping a bad pattern would silently widen the scope the user asked for.
- **Command centre (命令中心)** — MarkFlow's equivalent of VS Code's Command Centre: a **compact
  trigger** (not a persistent title-bar input field) that opens the `Ctrl/Cmd+K` Quick
  Open palette (placeholder "Go to file…", `⌘K` hint). It lives in the **global toolbar** — the
  editor pane's always-present tool row — so it stays visible with the
  sidebar closed and with no document open. It is the only visible entry for file-name
  search and deliberately sits in the global toolbar, not as a resident sidebar input. _See also_:
  **Quick Open**, **Search view**, **Global toolbar**.
- **Unsaved-changes guard (未保存守卫)** — the single store-level door every document switch must
  pass through (`selectDocument` / `openDocumentAt`): while the current document has unsaved edits,
  a confirmation names the document being left and offers discard / keep; "keep" cancels the switch
  (and writes no pending match) and returns focus to the editor. Side effects such as creating a
  document happen **after** the prompt. It exists because MarkFlow keeps one active document whose
  unsaved buffer lives only in the editor, so a switch would otherwise destroy it — VS Code needs no
  such prompt because it keeps a dirty working copy per editor (ADR-0023 decision 9). The guard
  governs **switching** only; unsaved text still participates in search (see **Dirty buffer snapshot**)
  and its document is skipped by cross-file replace.
  _See also_: **Search view**, **Global toolbar**.
- **Search entry points (搜索入口)** — every entry must **name its own range** in its visible label or
  tooltip, because no two of them search the same thing:
  _go to file_ (`⌘K`, command centre → Quick Open) / _search in files_ (`⌘⇧F`, Search view) /
  _find in document_ (`⌘F`, editor) / _replace in document_ (`⌘H`, editor — **editor-only**: it is
  NOT an entry point for the Search view, whose cross-file replace is opened from that view's own
  toggle) / _find in preview_ (`⌘F` in preview mode, find-only).
- **Find in folder (在此文件夹中搜索)** — the sidebar tree context-menu action that seeds the **Search
  view's** search scope (`./<subpath>`) from **where the user is** (VS Code's `Find in Folder`), rather
  than asking them to pick a mode first. On the root node it clears `include` only, preserving any
  `exclude`. _See also_: **Search scope**, **Search view**.
- **Relative path (相对路径)** — a document's `filePath` as seen from the **`workspaceRoot`** (the opened
  root folder), forward-slash separated (`2026/notes.md`); this is what a search result row shows and what
  **include / exclude** patterns are matched against. It is **not** relative to the **active folder** (that
  is UI drill state only — ADR-0023). The "Copy File Path" menu item still copies the **absolute** path —
  that is the form you can paste into a terminal or file manager.
  _Avoid_: rendering the absolute path in the UI.
- **File name (文件名)** — `basename(filePath)`, **including** the extension (e.g. `notes.md`).
- **Document title (`title`)** — the document's derived, **extension-less** file name (e.g. `notes`); what
  the sidebar shows. _Avoid_: using "file name" to mean `title`.
- **Glob pattern (通配符)** — a file-name pattern in VS Code's glob syntax (`/`, `*`, `?`, `**`, `{}`,
  `[]`, `[!]`). In **Quick Open** (the historical filename mode) a query containing a glob metacharacter
  switches from plain file-name matching to glob matching; a pattern without `/` matches the file name at
  any depth, one with `/` matches the path relative to **`workspaceRoot`**.

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
  image-error placeholder). _Removed_: `data-mermaid-source` — the "Copy diagram source" menu was
  deleted, so the mermaid source now lives only in the renderer's per-parse mermaid slot, never the
  DOM.
- **github-markdown-css（单一 Markdown 样式源）** — the preview and the exporter share the same
  `github-markdown-css` stylesheet (injected at runtime for the preview, inlined for export), so
  preview == export == print (WYSIWYG). It replaced the hand-rolled Tailwind Typography `.prose`
  rules. See `docs/adr/0018-preview-refactor-03-style-perf-media.md`.
- **lazy mermaid render（Mermaid 懒渲染）** — mermaid diagrams render in the DOM after the incremental patch,
  via IntersectionObserver + a content-hash SVG cache, instead of being baked into the HTML string. Avoids the
  ~2.5s first-paint regression and keeps re-parses from re-rendering unchanged diagrams.
- **complete bake（导出补齐烘焙）** — export / print / rich-text copy render **every** mermaid
  diagram into the canonical HTML before building their output, instead of reusing the
  preview's lazily-rendered DOM. The preview is allowed to be partial (viewport-driven); an
  output artifact is not. Shares the lazy path's content-hash cache, so a diagram the preview
  already rendered is never rendered again. ADR 0019.
- **intrinsic image dimensions（图片固有尺寸）** — local `appdoc://` images get `width`/`height` from
  `image-size` (main process, header-only, cached by path) before sanitize/patch, so the browser reserves
  space and the first paint doesn't jump (CLS). See `docs/adr/0018-preview-refactor-03-style-perf-media.md`.
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
  (`src/renderer/src/types/index.ts`), defaulting to `'system'`. The Markdown **preview** follows it:
  `MarkdownPreview.tsx` resolves `isDark` from `theme`, or from `matchMedia('(prefers-color-scheme: dark)')` when
  `theme === 'system'`, and sets `data-theme` on the `<article>`; the **exporter** follows it too (`export.ts`
  resolves `current` → UI theme, `system` → `matchMedia`). See
  `docs/adr/0018-preview-refactor-03-style-perf-media.md`.
- **主题 submenu (Theme submenu)** — the native **视图 (View)** menu carries a **主题** submenu with three
  radio entries: 浅色 / 深色 / 跟随系统 (Light / Dark / System). Picking one forwards the value to the
  renderer, which stores it and bridges it back to the main process (`app:set-theme` → `nativeTheme`), so the
  OS chrome follows too; the main process mirrors the value into the menu's radio checkmark. The choice is
  **not persisted** — every launch starts at 跟随系统. See `docs/adr/0028-theme-entry.md`.
- **跟随系统 (System)** — the default theme choice: the app resolves the OS `prefers-color-scheme` and
  **follows it live** (a light↔dark switch while the app is open updates immediately, no restart). The
  renderer owns the resolution: `App.tsx` applies the `dark` class on `<html>` through the shared
  `resolveTheme` helper, and **both** `App.tsx` and `MarkdownPreview.tsx` install a media-query
  listener only while the choice is `system` — the preview needs its own because it owns the two
  Markdown body stylesheets and the `<article data-theme>`.
  _Avoid_: "dark mode toggle" for this entry — it is a follow-the-OS mode, not a switch.

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
- **Format-key precedence (格式键优先)** — the policy that resolves a clash between a mainstream
  formatting shortcut (Bold / Italic / Link / Code / List / Task / Heading) and an existing MarkFlow
  app-command shortcut: **the format key wins and the app command relocates to a Shift chord**. Established
  by `docs/adr/0032-format-toolbar-shortcuts-and-precedence.md`. Currently applied as `⌘I` = Italic (File
  Details → `⌘⇧I`) and `⌘K` = Link (Quick Open → `⌘⇧K`). The freed `⌘I` / `⌘K` follow the Typora /
  Obsidian / Bear / Zettlr convention rather than VS Code.
- **renderer-only shortcut** — a keyboard shortcut handled entirely in the renderer (the `App.tsx` window
  capture listener → `markdown:insert`), with **no** matching native menu accelerator, so there is exactly
  one owner and no double-fire with CodeMirror. All format-toolbar shortcuts (`⌘B` / `⌘I` / `⌘K` / `⌘E` /
  `⌘⇧L` / `⌘⇧T` / `⌘1..6`) are renderer-only (ADR-0031 / ADR-0032). Contrast with app commands that also
  carry a native accelerator (e.g. Save `⌘S`).
- **format-shortcut table** — the single module (`src/renderer/src/lib/format-shortcuts.ts`) that owns every
  formatting binding: the key, the inserted markup and the advertised glyph. The window handler matches
  against it, and the toolbar tooltips plus the editor's right-click menu read the same glyphs from it — so a
  label can never drift from the key the handler implements (ADR-0032).
- **AUTO-block PR body** — the Create-PR Action manages PR bodies via symmetric `<!-- AUTO:key --> … <!-- /AUTO:key -->`
  markers; on refresh each segment resets to the template while human-written content outside the markers is
  preserved. (A planned generalization replaces the hardcoded blocks with scanned `.mjs` **block plugins** —
  designed but not yet implemented.) See `docs/adr/0005-committed-action-bundle.md`.
- **TypeScript 7 + ESLint TS6 shim** — the app builds on TS7 while `typescript-eslint` v8 still needs TS6 for
  the linter; `scripts/install-eslint-ts6.mjs` installs the TS6 checker side-by-side purely for lint. A
  documented transitional measure. See `docs/adr/0007-typescript7-eslint-ts6-shim.md`.

## Printing & windows

- **Main window** — the MarkFlow editor window: the only window the user normally sees, containing the
  editor, the **Preview pane**, the sidebar and the toolbars. _Avoid_: "preview window" — the preview is a
  pane inside this window, not a separate window.
- **Print host window** — a hidden, never-visible window that holds the rendered document for a print
  job and is the owner of the **System print dialog**. It must be set to `opacity 0` **before**
  `show()`: showing it first paints one opaque frame even if `setOpacity(0)` runs immediately after
  (the "a small preview window flashes by" report of 2026-11-13). _Avoid_: "print preview window",
  "print window", "preview window", "hidden owner" — these names caused repeated misdiagnosis.
- **System print dialog** — the OS-provided modal dialog for choosing a printer, copies and page setup.
  It is owned by the **Print host window**; while it is open the **Main window** refuses document and
  file mutations but keeps its **Preview pane** scrollable. Every toolbar button / context-menu item
  for a refused action is **visibly disabled** during that time and returns to its normal state when
  the dialog closes; read-only affordances (view mode, Find, Copy, preview scrolling) stay available.
  _Avoid_: "print window" when referring to the host, "print dialog" when referring to the host.
- **File lock (`fileLocked`)** — the capability that a document/file-set action is currently locked,
  derived as `printing || exporting || exportOpen`. UI controls and store guards ask THIS, never the raw
  trigger flags: a future trigger source is added in exactly one place (`selectFileLocked` in
  `store/ui.ts`) and every lock-aware control follows. The native menu receives a single boolean over
  `menu:set-file-locked`, mirrored from a store-level subscription, so adding a trigger source changes no
  IPC or menu code. _Avoid_ naming the capability after any single trigger (`printing`), which would
  force edits at every call site when a second trigger appears. See
  `docs/adr/0024-ui-convergence-spec.md` ("fileLocked capability").

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
- **`asar`** — Electron's archive format bundling the app payload into one read-only file (`resources/app.asar`). Enabled by default in electron-builder.
- **Lazy-load (dynamic import)** — loading a module on first use via `import()` instead of a top-level `import`. Used for `mermaid` (renderer first paint) and `franc` (export path).
- **Vendor chunk** — a build chunk holding third-party `node_modules` code, named `vendor-<pkg>` by the policy in `scripts/vendor-chunks.ts`. Splitting per package (plus a few grouped families such as mermaid and the CodeMirror/lezer editor stack) keeps each chunk independently cacheable and under the build's `chunkSizeWarningLimit`.
- **Synchronous render constraint** — `highlight.js` and `katex` are called synchronously inside `md.render()`, so they cannot be lazy-loaded without rewriting the render pipeline. See `docs/adr/0015-build-output-layout-and-bundle.md`.
- **Font formats** — `.woff2` is the modern, smallest web font format supported by Electron/Chromium. KaTeX also ships `.woff` / `.ttf` for legacy browsers; `scripts/prune-fonts.ts` prunes those because KaTeX's CSS lists `.woff2` first, so the legacy copies are never requested.
- **Fully bundled** — both the main process (`dist/electron/index.js`, no bare `require()` except Node builtins) and the renderer are self-contained Vite outputs, so the packaged app ships **no `node_modules`** (`electron-builder.json5` excludes them). Consequence: a dependency that is _read at runtime_ instead of being bundled works in dev and fails only in the packaged build — sign off dependency changes by running `npm run dist` and launching `release/win-unpacked/MarkFlow.exe`. See `docs/adr/0015-build-output-layout-and-bundle.md`.
- **Electron runtime floor** — the Chromium + Node payload every Electron app carries regardless of app-code size.
- **electron-builder cache root** — the directory where electron-builder stores downloaded toolset
  archives and their extracted contents. An absolute `ELECTRON_BUILDER_CACHE` value relocates it;
  it does not skip downloading anything. _Avoid_: calling a pre-build script's own directory "the
  electron-builder cache".
- **extractDir** — the per-toolset directory into which electron-builder extracts a downloaded
  archive, accompanied by a sibling status file that records a completed extraction. Its layout is
  an internal contract, not a stable public API.
- **prepared cache** — the Windows-only toolset a pre-build script _used to_ extract and mark with
  its own marker file (that script was removed in ADR-0037; the term is retained for history). It is
  a separate artifact from an **extractDir**: a "cache already prepared" message from that script
  described only the script's own work, not a cache hit by electron-builder.

## Testing infrastructure (e2e)

- **Playwright project** — one run configuration (its own `use`, `workers`, `retries`), **not** an
  owner of test files. Commands select projects by name (`--project=`); CI knows names, never spec
  paths.
- **Spec collection** — the files a project runs, determined by `testDir` (recursive scan root) plus
  `testMatch` (a filter relative to that root). In this repo every project owns **its own
  directory** and no project may set a `testMatch`, so the directory _is_ the ownership boundary:
  the rule is **one spec file, one project** (ADR-0034), locked by the
  `e2e/guards/project-ownership.test.ts` unit test rather than by a manual `--list` check.
- **Perf gate** — a fast, deterministic pass/fail performance check on every CI build. The
  large-document gate also emits its full diagnostic report _before_ asserting, so "gate" and
  "report" are two capabilities of one run, not two tests.
- **Perf diagnostic** — an on-demand, deliberately slow run that produces numbers instead of a
  verdict. It is kept out of CI so it cannot slow the pipeline; `retries` is 0 because repeating a
  measurement would corrupt the numbers.
- **Anti-drift** — a gate and the diagnostic it was calibrated from must drive the same code path.
  This is achieved by **sharing a helper**, never by sharing a spec file; two copies of a threshold
  are two sources of truth (ADR-0034).
- **Test axis** — the mechanism a test actually proves. A unit test can lock a binding table while
  an e2e test proves the keystroke reaches the editor past the native menu: different axes, so a
  unit test existing does **not** make the e2e test redundant. The authoritative rule for choosing a
  layer — the **mutation check**, the two removal situations, and "a flaky e2e is evidence" — is
  **Choosing the test layer** in `docs/agents/testing.md`, whose glossary also owns the term
  _mutation check_. Do not redefine those terms here.

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
