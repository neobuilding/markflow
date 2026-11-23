# ADR-0040: Document tabs and cross-window tab transfer

- **Status:** Superseded in part by ADR-0042 (§3 and §5: navigation history is now one global position stack, not per-tab).
- **Decided:** 2026-11-22
- **Amended:** 2026-11-24 (ADR-0042)
- **Supersedes:** ADR-0038 R-e ("there is at most one open document in an app instance"); ADR-0039 §3.1's per-window history clause.
- **Amends:** ADR-0038 §3.5 decision 11 / Consequences (draft discard on switch), ADR-0039 §3.5, ADR-0033 (editing session / undo), ADR-0024 §4 (new UI primitives), CONTEXT.md.
- **Related:** ADR-0004, ADR-0016, ADR-0023, ADR-0024, ADR-0034, ADR-0036, ADR-0038, ADR-0039, ADR-0041.

_Contradicts ADR-0038 (at most one open document; the app instance keeps a single active document) and ADR-0039's per-window history statement, but worth reopening because the per-window multi-window foundation (ADR-0039) has landed and tabs are the next step on it; a single active document makes "open in a new window" the only way to keep two files visible._

## Requirement

A window must hold several open Markdown documents at once, each as a tab; unsaved text (body and title) must survive switching tabs; each tab must have its own browser-style Back/Forward history; a tab may be dragged out into a new window or moved to another MarkFlow window without losing its document, draft, or history.

## 2. Evidence

- The per-window foundation exists: `WindowContext` + ALS (`model/windowContext.ts`, `model/ipcScope.ts`), per-window document store / root / watcher. No tab concept exists in `src/` (only the sidebar's ARIA activity-bar tabs).
- Drafts live in the editor instance plus a per-document-id buffer registry; `selectDocument` clears the buffer on switch and `useLocalDocument` overwrites the draft from disk (`store/ui.ts:137-143,356-372,388-408`, `hooks/useLocalDocument.ts:57-124`). The current `setActiveDocumentId` is destructive, not a plain activation.
- `store/navigationHistory.ts:58` is a single zustand store; there is no history factory (verified repo-wide). `withoutHistoryRecording` uses a module-level counter (`:43-56`).
- VS Code shows an **aggregate** save dialog: one prompt naming all dirty files, Save All / Don't Save / Cancel, with Cancel vetoing the whole close — `workingCopyBackupTracker.ts:297,326-327`, `abstractFileDialogService.ts:196-218` in the local `D:\GitHub\vscode` checkout. Its desktop `window.confirmBeforeClose = never` default is safe only because hot-exit backs up dirty copies first (`workbench.contribution.ts:989`, `workingCopyBackupTracker.ts:125-126`). MarkFlow has no recovery and no save-all capability, so a blocking aggregate prompt without Save All is the correct analogue.
- Browser history is per tab. Right-click _Duplicate_ copies Back/Forward history, while opening the same URL in a genuinely new tab starts with a one-entry stack (tab-launcher-app guide, 2026-11-20, secondary source citing Chromium); dragging a tab between windows moves the same tab and keeps its history. `beforeunload` (MDN) is per tab, has a browser-fixed message, and needs sticky activation — not a model for an editor with real save.
- Exact `file:line` anchors were verified against the 2026-11-22 working tree before implementation; line numbers drift, so symbols are the durable references. Gitignored planning documents are intentionally not cited here.

## 3. Decision

1. **Tabs are renderer-owned state** (`store/tabs.ts`); a `BrowserWindow` holds many tabs and a document belongs to at most one window. Main moves documents between windows; it does not own tab order or activation.
2. **Switching tabs keeps drafts** (user decision 2026-11-22): both body text and unsaved title. The discard guard moves from the switch path to the close path; `useLocalDocument` restores a tab's draft before reading disk. `setActiveDocumentId` becomes a pure mirror of the active tab.
3. **Navigation history — originally one stack per tab** (user decision 2026-11-22, overriding the earlier per-window recommendation): `Map<tabId, HistoryState>`; switching tabs did not record navigation; detach/cross-window move carried the tab's stack. **Superseded 2026-11-24 by ADR-0042**: one global position stack per window, entries carry `tabId` and editor position, replay activates the recorded tab, and links to already-open targets record a navigation so Back returns to the source. Replaying an `external-switch` entry still switches the window root in a dedicated mode that reuses the initiating tab and keeps the aggregate dirty guard.
4. **Workspace stays per window and single-root** (ADR-0039 §3.1 unchanged), shared by all tabs in that window. Opening a workspace imports every Markdown file for the sidebar but opens only the first document as a tab; every other file becomes a tab only when explicitly selected. Whether that tab is preview or pinned, and how later files open, follow ADR-0041. A workspace switch keeps tabs whose file is in the new root (re-imported, drafts migrated, out-of-root history entries pruned) and closes the rest after one aggregate confirmation.
5. **Cross-window transfer is a move with a complete in-memory handoff**: the renderer proposes the drag token synchronously in `dragstart` (DataTransfer is writable only there) and main registers that exact token; it is consumed exactly once (drop wins over detach; detach is delayed and re-checked). Unknown senders and missing files produce an empty token, not a pseudo-token protocol. The handoff includes `tabId`, body and title drafts, history entries and cursor; the destination re-imports the file (or creates a new draft) with the same `tabId`, and the source disposes its history only after the destination ACKs. Consumed-but-unacknowledged sessions expire after the same 5s TTL, after which the source keeps its tab. A file-backed detach uses `take-handoff` alone and does not set `pendingPaths`, avoiding a startup race that would clear the draft.
6. **Close-window dirty prompt stays aggregate** (user-confirmed): one dialog listing all dirty tab titles, Cancel vetoes the whole close, no Save All. Closing a single dirty tab keeps its own per-document prompt. Save/export/dialog locks block all tab and window close paths.

## 4. Consequences

- `activeDocumentId` remains a mirror of the active tab's document so existing readers need no change; `activeTabId` is the source of truth. Every `setActiveDocumentId` call site (11 in production, plus tests and e2e helpers) must be reclassified as activation vs navigation.
- `navigationHistory` originally became a multi-instance factory with per-tab stacks; ADR-0042 collapses this to one global stack per window (the factory remains only for isolated tests), with the active tab's id and editor position stored in each entry.
- Undo history is **not** kept per tab: returning to a tab restores text and dirty state but not its CodeMirror undo stack. Keeping undo would require a per-tab editor instance and is a separate change.
- All new IPC goes through `scopedHandleFor`; the drag-session source is resolved with `exactContextFor`, never the `activeContext()` fallback. A Vitest guard checks this invariant.
- No tab state is persisted (CONTEXT.md "No persisted settings"); a new window restores only the handed-off tab with its draft and history.
- CONTEXT.md glossary (`Tab`, `Tab navigation history`, `Tab handoff`), the ADR-0038/0039 back-links, and the ADR-0024 UI primitive list are updated when the implementation lands (plan P7).
- Tests follow the project pyramid: state, draft, history, dialog copy, DataTransfer timing, IPC scoping, and handoff payload are unit/component tested with per-file 100% coverage; e2e is limited to a real new `BrowserWindow` consuming `take-handoff`, real cross-window IPC routing/ACK, and the real window-close dialog with Cancel veto. Playwright cannot reliably drive native cross-window HTML5 drags, so pointer-level timing stays at the component layer instead of becoming a flaky e2e.
