# ADR-0039: Per-window workspaces, external documents, and multi-window navigation

- **Status:** Accepted
- **Superseded in part by:** ADR-0040 §3.1 (per-tab history replaces the single per-window stack); ADR-0040 §3.4 (tabs share the per-window workspace).
- **Decided:** 2026-11-21
- **Supersedes:** ADR-0038 §3.1.3 (Open/Copy/Cancel as the only external path), §3.2 decision 5 (workspace always replaced by a link target's folder) and §3.4 decision 9 ("no history dropdown") — only in the four-way / new-window / history-menu parts.
- **Amends:** `CONTEXT.md` (Workspace, Opened root folder, Document navigation, Navigation history, Back/Forward, Reveal in sidebar, Main window, Link destination); ADR-0023 decision 3 ("single-window app").
- **Related:** ADR-0023, ADR-0038

- **Implementation status (2026-11-22):** all sections are implemented and covered by the full unit
  suite (2868 passed / 172 files; `e2e:app` 220 passed): per-window `WindowContext` + ALS-scoped IPC (§3.1), four-way
  external-file choice across links/drop/file-association/Open menu (§3.2), external documents with
  badge and single-file watcher (§3.3), per-window close guard and macOS lifecycle (§3.4),
  and structured history with the right-click menu (§3.5). A fourth review round tightened three
  per-window invariants: buffered edits made during the workspace-switch awaits are migrated from
  fresh store state, watcher notifications are sent to the owning window (coalescing is keyed by
  window + directory), and a quit-pending report is attributed to the exact sender window so one
  window's prompt cannot disarm another window's safety net.

---

## 1. Requirement

ADR-0038 established a single root per app and "workspace follows the active file". Subsequent
work exposed three needs that decision did not cover:

- A link / drop / file-association target outside the workspace must not silently replace the
  user's workspace (which would discard an unrelated in-progress document). It must offer a choice.
- More than one window may be open at once, each with an independent workspace and history. A
  workspace-external file can be handed to a second window instead of disturbing the current one.
- Browser-style Back/Forward should let the user pick a specific recent entry, not only step one
  at a time.

## 2. Evidence

- VS Code opens an editor link in the current window regardless of workspace; MarkFlow's one-root
  model makes that destructive here, so a four-way choice is a deliberate divergence (see §4).
- Electron's window template quits on `window-all-closed` only off macOS; macOS keeps the process
  and recreates a window on `activate`.
- Chrome/Edge Back/Forward buttons expose a right-click list of recent entries; selecting one
  positions the cursor without appending a new history entry.
- The renderer already owns every "open a path" entry point (menu, drag-drop, file association,
  cold start), so the four-way decision belongs in the renderer with main providing only the
  dialog and window primitives.

## 3. Decision

### 3.1 Workspace is per-window

- Each `BrowserWindow` owns an independent `workspaceRoot`, document store, folder watcher and
  navigation history. In main these live in a `WindowContext` resolved from the requesting
  `event.sender` through an `AsyncLocalStorage` scope at every IPC boundary.
- Opening a folder still **replaces** that window's workspace (ADR-0023 single root, unchanged).
  Multi-root workspaces remain out of scope — now per window, not per app.
- `activeFolder` is a renderer-only UI notion (which subfolder is shown); only `workspaceRoot`
  defines search/navigation scope.

### 3.2 Four-way external-file choice

A Markdown file that resolves outside the current `workspaceRoot` — from a preview link,
drag-drop, a file association, or the Open File menu — presents a four-button dialog:

1. **Open in new window** (default) — hand the path to main; reuse an existing **other** window
   whose root already contains it (focus + reveal), otherwise create a window rooted at the file's
   directory. The requesting window is never a reuse candidate: for a file already inside its own
   root, focusing itself would be a no-op, which is exactly the "nothing happens" bug this rule
   fixes.
2. **Open here (keep workspace)** — import the file as an external document: real `filePath`,
   `external: true`, no sidebar row, excluded from search/replace.
3. **Open here & switch workspace** — replace this window's root with the file's directory AND make
   the picked file the active document. The history records that file with `openMode:
'external-switch'`, so replaying the entry switches the workspace back instead of failing on a
   path that lies outside the current root.
4. **Cancel** — no action.

_Contradicts ADR-0038 §3.2 decision 5 ("target folder always replaces the workspace"), but worth
reopening because that rule silently discarded the current workspace for out-of-root files._
_Contradicts ADR-0038 §3.1.3 ("Open / Copy / Cancel" as the only external path) for Markdown files:
that choice is retained for non-Markdown `localFile` and URI schemes; workspace-external Markdown
now uses the four-way dialog._

Folders and multi-file batches keep the existing "replace workspace / refuse unrelated roots"
behavior (they never use the four-way dialog). The unsaved guard stays at the single close point:
only branches that actually close the current document guard; "new window" and "cancel" do not.

Implementation note (2026-11-22): when there is **no** workspace root at all — cold start, file
association, or a workspace the user closed — a single Markdown file opens directly in the current
window through `useOpenPaths`, which sets the root to the file's folder. The four-way choice is
only meaningful when a root exists and the target lies outside it. The switch branch calls the
SINGLE file guard (`guardUnsavedSwitch`) and closes the document before replacing the root
(ADR-0038 §3.2 decision 6) — there is no second `app.unsavedOpenWorkspace` prompt, and "Keep
editing" returns focus to the editor.

### 3.3 External documents

An external document is in-memory, keyed by id like any document, with `external?: boolean`. It is
watched by a single-file watcher owned by that window's context; the watch follows the document's
lifetime — it is released when the document is deleted and dropped when the workspace changes. It
is visible in the editor (with an "Outside workspace" badge) and in navigation history, but not in
the sidebar tree or search results.

The folder watcher is per window as well (its handle, own-write suppression and pause state live
in the window's context), but the **handler set is installed once** for the whole process. Every
window's watcher state is therefore seeded with that set when the state is created, and each
watcher callback re-enters its own window's scope — otherwise a window that opened its workspace
after startup would drop every event and its sidebar would never refresh. Renderer notifications
raised by those handlers must resolve their target from that same scope, never from a process-global
"main window"; a second window's sidebar would otherwise stay stale while the focused window
received irrelevant refreshes. Coalescing timers are keyed by window and directory, and a workspace
swap cancels only that window's pending broadcasts.

### 3.4 Multi-window lifecycle

- Closing a window prompts only that window and closes only it. Closing the last window quits the
  process on Windows/Linux but keeps it alive on macOS (`activate` recreates a window).
- **There is no application-level quit.** No Cmd+Q / menu Quit, no `before-quit` veto, and no
  all-window vote: unsaved changes are resolved when a window closes, never at process exit. When
  the OS asks the app to terminate (macOS Dock Quit), Electron closes each window first, so the
  same per-window guard still runs. System shutdown is **not** intercepted — the OS may terminate
  without any prompt. This replaces the earlier application-level quit design (D15).
- The close handshake is **attributed to the sending window**: `app:quit-pending` and
  `app:quit-allowed` are credited to the window whose renderer sent them, never to whichever window
  happens to be focused. A renderer that confirmed a _workspace_ close ("Close Workspace") does not
  close its window. A reply that cannot be attributed to any live window is ignored: falling through
  to a headless force-close could close the wrong window.
- A "reveal file" event lets a reused window focus and navigate to the file without changing its
  workspace.
- The shutdown path must never touch a **destroyed** window. Electron throws
  `TypeError: Object has been destroyed` for `win.webContents` after the window closed, and an
  uncaught exception inside an Electron event handler opens the native "A JavaScript error
  occurred in the main process" dialog — a modal that blocks the main thread, so the app could
  not be quit at all. The window's `webContents` id is therefore captured at registration
  (`ctx.id`) and reused by the teardown.
- The shutdown path releases every window's folder watches through the **same** window registry
  the rest of the app uses (a static import). A dynamically imported copy of the registry module
  would be a second instance with its own `contexts` map, so it would stop nothing.

### 3.5 Structured navigation history with a right-click menu

- History entries are `{ path, title?, openMode? }`; `openMode` is replayed on Back/Forward so an
  externally-opened document reopens in the same mode without re-prompting. Replaying an
  `external-switch` entry moves the workspace to the file's folder; replaying an `external-keep`
  entry opens the file in place as an external document.
- Back/Forward buttons expose a right-click list of the recent N entries (nearest first). Choosing
  one positions the cursor via `moveToHistoryIndex`, which never appends a new entry.

_Contradicts ADR-0038 §3.4 decision 9 ("no history dropdown"), but worth reopening because browser
users expect to jump to a specific recent entry._

## 4. Consequences

- The four-way choice is an intentional divergence from VS Code: MarkFlow has one root per window,
  so opening an out-of-root file in-place would destroy workspace context.
- Per-window isolation required replacing module-level main-process singletons with an ALS-scoped
  `WindowContext`; every IPC handler must go through `scopedHandleFor`/`scopedOnFor` or it silently
  falls back to the headless context.
- External documents are session-only; closing their window or exiting the process drops them like
  any other in-memory state.
- Memory-only drafts are still purged on quit and never survive a restart (ADR-0038 §3.5,
  unchanged).
