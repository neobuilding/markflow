# ADR-0042: Global document-navigation history with editor positions

- **Status:** Accepted
- **Decided:** 2026-11-24
- **Supersedes:** ADR-0040 §3, §5.2, §5.5 (per-tab navigation history); ADR-0041 §5 (preview replacement disposes the old tab's history); ADR-0038's browser-tab-stack analogy where it conflicts with this ADR.
- **Amends:** ADR-0040 §4, §5.4; ADR-0041 §Link semantics; CONTEXT.md.
- **Related:** ADR-0038, ADR-0039, ADR-0040, ADR-0041.

## Context

ADR-0040 gave each tab its own Back/Forward stack, following the browser's per-tab model. ADR-0041 later added a single replaceable preview slot per window: opening a link from an unpinned tab replaces it, while a pinned source gets a new preview tab, and an already-open target is activated rather than duplicated.

Three user decisions exposed a conflict between those models:

1. A link clicked in document A whose target B is already open in another tab must activate B, not create a second B tab (MarkFlow drafts are keyed by `documentId`; duplicate tabs would share the draft and dirty flag).
2. Back from B must return to A — the source of _this_ navigation — and Back again must continue to A's earlier source.
3. Closing a tab must not jump to a history entry.

With one stack per tab, satisfying (1) and (2) simultaneously is impossible: recording the navigation in the source stack desynchronises its cursor from its displayed document; recording it in the target stack interleaves entries from unrelated tabs, so neither stack has a continuous chain. A global stack removes the conflict: one entry records both "where I went" (document + tab) and "where I was" (editor selection), regardless of which tab is active.

This follows VS Code's `historyService.ts`: `IEditorNavigationStackEntry { groupId, editor, selection? }`, one global stack with `workbench.editor.navigationScope: 'default'`, `goBack/goForward` calling `openEditor(editor, options, groupId)`, and `TextEditorPaneSelection.restore()` applying `{ selection, selectionRevealType: CenterIfOutsideViewport }`. VS Code records the text editor selection (start/end line/column), not scroll position; MarkFlow's equivalent is a character range.

## Decision

1. **One global navigation stack per window** (`useNavigationHistory`), not one per tab. An entry is `{ path, title?, openMode?, tabId?, position? }`; `tabId` is the stable tab that displayed the document and `position` is `{ start, end }` character offsets in the editor. `cursor` is a single index. Back/Forward and the history menu operate on this stack.
2. **Position capture and restore**: on a new navigation (sidebar click, link, search hit, reveal, workspace switch), capture the active editor's current selection into the _current_ entry, then push the target entry. A cursor move alone only updates the current entry's position — it never creates an entry. Replay restores the entry's position by setting `pendingMatch`, which the editor consumes to select and scroll to that range. Preview-pane scroll is not recorded (VS Code does not record it either; MarkFlow's preview scroll is component-private). In preview-only mode there is no editor position to restore, so replay only switches documents.
3. **Replay activates the recorded tab** (`entry.tabId`) when it still exists, or opens the document as a new tab when it does not. Activating an already-open target is a navigation: the entry is pushed so Back returns to the source document and its position. History replay (`record: false`) never pushes or rewrites positions. An `external-switch` entry replays into `entry.replayRoot` (the exact root recorded at switch time, falling back to `dirName(path)` for legacy entries), so Back/Forward cross workspace boundaries without losing the origin.
4. **Links follow ADR-0041's preview slot**: an unpinned source with an unopen target reuses the _same tab id_ via `replaceDocument` + `updateTab` (the global stack and cursor survive; no `disposeHistory`); a pinned source opens a new preview tab; an already-open target is activated with a new global entry. Source and target positions are preserved.
5. **Workspace first document and workspace-switch tab creation open unpinned** (`preview: true`). The first document is recorded as the initial global entry, so Back has a source and replays carry a tab id. A link-driven `external-switch` marks the current (source) entry `external-switch` with `replayRoot` before the root swap; this keeps it in the stack past `pruneOutOfRoot`, so Back returns to the source workspace. Switch entries record the tab that will display the target (replay target, fresh preview tab, or kept active tab) and capture the editor position before the swap. Ordinary folder switches keep the existing prune rule; `external-keep` never prunes or switches roots. `external-switch` history replay continues to reuse the initiating tab so the file's folder swap keeps its stable tab id.
6. **Closing a tab never jumps in history**. The active neighbour is still right-then-left (`tabList.ts:neighbourAfterRemove`), and the closed tab's global entries are not pruned: paths are durable and a replay of a stale entry opens the document in a new tab, mirroring VS Code's stale resource entries. Replay of an entry without a `tabId` reuses the active preview tab instead of adding one. **Closing the workspace clears the whole global stack** (unlike a single-tab close): the session, its tabs and its drafts are gone, so external-mode leftovers must not survive into the next workspace.
7. **Cross-window handoff** carries only the moved tab's current entry as the destination's first global entry; the source window's global stack is not transferred wholesale.

## Consequences

- `tabHistory.ts` collapses to thin adapters over the single store; `getHistory(tabId)` and `pushTabHistory(tabId, …)` keep their signatures so call sites stay source-compatible, but every call resolves to the same store and records `tabId` in the entry. `disposeHistory` becomes a no-op for normal close (the global stack has no per-tab instance to release).
- `NavigationEntry` gains optional `tabId` and `position`; `UIState` gains an editor-selection mirror and a `pendingMatch` setter used by replay.
- ADR-0040 §3 and §5 are historical records of the first iteration; their per-tab rules are superseded here. Draft, tab, and handoff rules of ADR-0040 remain in force.
- Tests: history store and navigation unit tests assert one stack with `tabId`/`position`; component tests assert position capture; e2e covers Back returning to the source document and position after a link click, and Close keeping the neighbour active.
