# ADR-0038: Document navigation history, workspace-follows-file, and draft lifetime

- **Status:** Accepted
- **Superseded in part by:** ADR-0039 §3.2 (four-way external-file choice replaces §3.1.3 /
  §3.2 decision 5 for workspace-external Markdown files) and §3.5 (right-click history menu
  replaces §3.4 decision 9's "no history dropdown").
- **Decided:** 2026-11-20
- **Supersedes:** ADR-0006's "Unsaved drafts" sidebar group and switch-back-to-draft behavior (§3.5;
  its no-disk-write-before-save rule is unaffected either way)
- **Amends:** `CONTEXT.md` (Draft, Memory-only document, Document navigation, Navigation history,
  Back/Forward, Reveal in sidebar)
- **Related:** ADR-0002 (single sanitization gate), ADR-0006 (memory-only documents), ADR-0020
  (fragments in preview), ADR-0023 (single workspace root), ADR-0029 (read-only default)

- **Implementation status (2026-11-20):** all sections are implemented: §3.1 preview link policy,
  §3.2 workspace-follows-file, §3.3 sidebar reveal, §3.4 path-keyed navigation history with
  Back/Forward buttons and focus-gated shortcuts, and §3.5 draft lifetime. ADR-0006 is superseded
  in the draft-switch part only; its no-write-before-first-save rule stays in force.

---

## 1. Requirement

| #   | Requirement                                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-a | Relative and absolute links in Markdown must open the target document in-app; the window must never be navigated to the link URL.                          |
| R-b | After any document change, the sidebar must show where you are: expand ancestors and select the file.                                                      |
| R-c | Back/Forward controls in the global toolbar must behave like Chrome/Edge for the app's document navigations.                                               |
| R-d | Opening a document outside the current workspace must replace the workspace with that file's folder, while Back can return to the previous file/workspace. |
| R-e | A memory-only draft must not survive a document switch; there is at most one open document in an app instance.                                             |

---

## 2. Evidence

- **Link bug (reproduced).** The preview emitted raw `href="target.md"`; with no `<base>`, Chromium
  resolved it against the app shell (`http://localhost:5174/target.md` in dev, the install directory
  in a packaged build). Left-click navigated the whole window: `article.markdown-preview` vanished
  and the app appeared hung. `windowOpenHandler` does not cover same-frame clicks.
- **Markdown link forms.** CommonMark 6.3 defines a link destination as an arbitrary character
  sequence (`[link](/uri)` is normative); the original Markdown syntax document explicitly permits
  relative paths. `file://` is **not** required. VS Code's markdown link resolver excludes
  single-letter schemes such as `C:` from external-URI detection, treats a leading `/` as
  **workspace-root-relative**, and sends other absolute URIs to the OS.
- **Current toolchain.** `markdown-it` drops `file:` links by default (`validateLink`), and
  `DOMPurify` strips `file:` from `href`; a bare `C:` is misread as a URI scheme by a naive regex.
  All three must agree on one link policy (ADR-0002).
- **Workspace model.** `setWorkspaceRoot` clears the document store and rebuilds the watcher, so
  document ids are invalid across a workspace change; a durable navigation key must be the absolute
  file path. `selectDocument`'s unsaved guard only clears the dirty buffer today; `closeDocument`
  is what deletes a memory-only draft row.
- **Shortcut conflicts.** CodeMirror binds `Alt+ArrowLeft/Right` to syntax movement (Windows/Linux;
  macOS uses `Ctrl+ArrowLeft/Right`) and `Mod-[` / `Mod-]` to indent. VS Code's browser-style
  shortcuts are `Alt+←/→` on Windows, `Ctrl+-` / `Ctrl+Shift+-` on Linux, `Ctrl+-` on macOS — not
  the same combination on every platform. Chrome/Edge use `Alt+←/→` (Windows/Linux) and
  `Cmd+[` / `Cmd+]` (macOS).

---

## 3. Decision

### 3.1 Preview link policy

1. Every plain left-click on a preview anchor is intercepted and `preventDefault()`ed; the Electron
   window is never navigated. A resolved link is dispatched to one of: open in-app document, open
   externally with confirmation, in-preview anchor scroll, or ignore.
2. Local Markdown targets are relative paths, `C:\…` / `C:/…`, `file:///…`, and `/…`. A leading `/`
   is resolved **relative to the workspace root** (VS Code semantics), not to the current drive;
   with no workspace it is invalid. UNC paths are out of scope. Non-Markdown targets are not
   documents and go through the external path.
3. `http:`, `https:`, `mailto:`, `tel:`, and non-Markdown local files open in the OS default
   handler **only after** a confirmation dialog (Open / Copy / Cancel, VS Code style). No
   trusted-domain persistence is added in this version. Unknown/dangerous schemes (`javascript:`,
   `data:`, `appdoc:`, …) are ignored. Markdown-it's `validateLink` and DOMPurify's `ALLOWED_URI_REGEXP`
   are both widened to accept the local forms above; sanitization stays single-gate (ADR-0002).
4. `#heading` / `#L10` in a Markdown link scroll the opened document; they do not create a separate
   navigation history entry.

### 3.2 Workspace follows the active document

5. Any document navigation whose target file's folder differs from `workspaceRoot` **replaces** the
   workspace with that folder (ADR-0023's single root is preserved), then opens the file. Explicit
   Open Folder / Close Workspace do not clear the history.
6. The unsaved guard order is: file guard (`app.unsavedSwitch`) first → close the current document
   (which deletes a memory-only draft and clears `dirty`) → replace the workspace. There is no
   second `app.unsavedOpenWorkspace` prompt on this path: once the document is closed there are no
   edits left to discard (the user's explicit correction). "Keep editing" cancels the navigation.
   Closing the document always precedes closing the workspace.

### 3.3 Sidebar reveal

7. On **every** active-document change — sidebar, search, command palette, preview link, new
   document, Back/Forward — the sidebar expands the target's ancestor folders, sets `activeFolder`
   to its folder if needed, and scrolls the file row into view. This is one seam in the sidebar, not
   per-entry-point logic.

### 3.4 Navigation history and Back/Forward

8. The history is an in-memory list for the lifetime of the app process. Entries are keyed by
   **absolute file path** (not document id), so they survive workspace replacement. Back/Forward
   reloads the entry's containing folder as workspace when needed. A new navigation truncates the
   forward part. Entries whose files no longer exist are skipped and pruned when traversal reaches
   them. Memory-only drafts never enter history.
9. Back and Forward buttons live in the global toolbar next to Quick Open, follow browser semantics
   (disabled at the ends, new navigation truncates forward), and are disabled while `fileLocked`.
   They are toolbar-only in this version: no history dropdown and no native menu accelerators.
10. Browser-style shortcuts (`Alt+←/→` on Windows/Linux, `Cmd+[` / `Cmd+]` on macOS) act on history
    **only when focus is outside the editor**. When focus is in the editor, those combinations keep
    their CodeMirror meanings (syntax movement / indent) and no replacement history shortcut is
    assigned there.

### 3.5 Draft lifetime

11. Switching the active document closes the current memory-only draft through the normal unsaved
    guard and deletes its store row. The single current draft stays visible in the sidebar's
    "Unsaved drafts" group while it is active, but no draft can be switched back to once left —
    the group never offers a second, switchable draft. This supersedes ADR-0006's switch-back
    behavior but keeps its "never write a file before the first explicit save" rule.

---

## 4. Consequences

- **Positive:** clicking a link can no longer wipe or hang the window; users can always see and return
  to the file they came from, even across folders; one active document means no ambiguous dirty buffer.
- **Positive:** path-keyed history and file-following workspace make Back/Forward meaningful after a
  workspace replacement, without persisting history across restarts.
- **Negative / trade-off:** a draft is destroyed on any document switch, so a user who switches away
  loses the typed content after confirming the discard dialog (ADR-0006 previously allowed returning
  to it). `file:` and drive-letter hrefs need coordinated changes in two sanitization-related layers.
- **Negative / trade-off:** browser-style keyboard shortcuts are deliberately unavailable while the
  editor has focus, so Back/Forward there is mouse/toolbar only.
- **Known limitation:** navigation-history and workspace matching use the case-insensitive
  `sameFilePath` helper (shared `arePathsSame` rule). On a case-sensitive filesystem (Linux) two
  paths differing only in case are distinct files but fold to one history entry. This is accepted:
  paths come from the OS document store and user-typed links commonly differ in case, so folding
  avoids duplicate entries on the predominant case-insensitive platforms. Callers needing
  platform-exact identity use `arePathsSame` with `pathCaseSensitive()` (ADR-0014).
- **Reversible:** each decision is local — link policy, history stack, reveal seam, and draft closure
  can be changed without altering the document store schema or the disk model.
