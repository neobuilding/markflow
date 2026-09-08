# ADR-0006: Memory-only new documents (no disk write until first explicit save)

- **Status:** Accepted
- **Implemented:** 2026-08 (`PLAN-improvements-2026-08-done.md` §6.3 / §6.5)

## Context

The original new-document flow called `documents:create`, which immediately wrote
`<title>.md` into a default directory (`~/Documents/MarkFlow` or the open folder). That left a
stray file on disk whenever the user cancelled Save-As or closed the doc without ever saving, and it
violated the product rule "never create a file on disk before an explicit save."

## Decision

`documents:create` gains a `memoryOnly?: boolean` parameter:

- When `memoryOnly: true`, skip the disk write **and** the file watcher; insert only a draft row with
  `file_path = ''`. The renderer marks the doc `isNewUnsaved`.
- The first **Save** on a new unsaved doc routes to **Save As** (path dialog); the user cancelling keeps
  the doc in memory with no file written.
- `watchDocument` / `documents:delete` / `documents:update` all guard on empty `file_path` (no watch,
  no `unlinkSync`, no `writeFileSync`), so a memory-only doc never touches the filesystem.
- **Quitting = closing the workspace.** Window close / `before-quit` run the _same_ `tryCloseWorkspace()`
  logic (with the unified `app.unsavedCloseWorkspace` prompt) and then `app.quit()`. Unsaved drafts are
  purged (`purgeUnsavedDrafts`) **only after** the user confirms — never silently.
- Memory-only drafts are **not** persisted across app restarts.

The sidebar shows memory-only drafts in a dedicated **"Unsaved drafts"** group (empty `file_path` is
excluded from the folder tree via `isInFolder`, which is always false for `''`).

## Consequences

- **Positive:** no stray files; new-document editing reuses the exact same dirty-prompt path as existing
  files.
- **Positive:** the "Unsaved drafts" group gives the otherwise-pathless doc a sidebar entry to switch back
  to.
- **Negative / trade-off:** the window-close/quit path is unified and slightly more involved; the dirty
  prompt must be fired from the renderer before the main process may quit.
