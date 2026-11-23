# ADR-0041: VS Code-style preview tabs

- **Status:** Accepted
- **Decided:** 2026-11-23
- **Amended:** 2026-11-24 (ADR-0042 changes the history consequences of decisions 3 and 5; ADR-0042 supersedes the per-tab history assumption in §5 and in the link model).
- **Related:** ADR-0040, ADR-0042

## Context

ADR-0040 gave every opened document its own tab. A single click in the sidebar now creates a permanent tab, so browsing a workspace accumulates tabs even when the user only wanted to look at a file. VS Code separates two states that are both casually called “pinned”: `preview`/`pinned` (a replaceable preview tab per editor group) and `sticky` (the separate UI Pin feature). Only the first is needed here.

VS Code source: `editorGroupModel.ts:212-214` keeps one preview editor per group; `workbench.contribution.ts:331-334` documents that the next preview replaces it; `listService.ts:718-734,737-755` makes single click preview and double click/Enter pinned; `editorGroupView.ts:861-864,1202-1208` pins dirty editors and applies the `pinned` option; `multiEditorTabsControl.ts:1838-1844` italicizes preview labels.

## Decision

1. The domain terms are **preview tab** and **non-preview / pinned tab**. User-facing Chinese uses **未固定 / 固定** and English uses **unpinned / pinned**; “临时”, “预览标签页”, “locked”, and VS Code's separate UI Pin/sticky are avoided. The UI word `Pin` here means only “make this tab non-preview”.
2. Each window keeps exactly one preview slot (`previewTabId`). A tab is preview iff its id equals that slot; pinned state is derived, not stored per tab.
3. Sidebar file single click and search-result click open preview; double click / middle click / Enter opens pinned. Command-palette document picks are pinned. Links in the rendered Markdown preview, `app:reveal-file`, and the `open here (keep workspace)` external-file choice open the target as preview **without pinning the source** (see _Link semantics_ below). Opening a workspace or a no-tab workspace switch opens the first document as the preview tab; creating a new/dirty document opens pinned.
4. Dirty transition (body or title), tab double click, `Pin`, in-window reorder, cross-window move and detach pin the affected tab. Opening a document that is already open in pinned mode activates it; opening the current preview again only activates it. Activating another pinned tab does not change the preview slot.
5. A new preview replaces the old preview. Dirty editors are pinned before replacement, so an automatically replaced preview is clean. A link from the unpinned preview reuses the **same tab id** (`replaceDocument` + `updateTab`); navigation history is one global stack (ADR-0042), so no per-tab stack is disposed and the global cursor survives. No reopen-history feature is introduced.
6. Closing the preview clears the slot; closing a pinned tab does not. Workspace switches preserve the preview state of kept tabs and clear the slot if the preview tab closes. Cross-window move/detach always pins the target; the new window has no preview slot.
7. Visible tab labels contain only the document title and use italics for preview; tooltips/ARIA append a short localized `（未固定） / (unpinned)` qualifier; the context menu action is `固定 / Pin`. There are no persisted preview settings; VS Code's defaults above are fixed behavior.

### Link semantics

Rendered Markdown preview links are **not** code navigation. When a link target is opened as preview:

- If the active tab is the current preview slot, that tab is **reused in place** (`replaceDocument` + `updateTab`, same tab id) — the source is not pinned first.
- If the active tab is pinned, it stays open and a new preview tab is created for the target.
- If the target document is already open (preview or pinned), it is activated, the preview slot does not move, and a global history entry records the navigation (ADR-0042 §3) so Back returns to the source.

The same rule applies to `app:reveal-file` and the `open here (keep workspace)` external-file choice. A dirty source is already pinned by decision 4, so it can never be silently replaced.

VS Code's `openCodeEditor` (Go to Definition and other code navigation) _does_ pin the source before opening the target as preview; that behavior belongs to a code-navigation surface only. MarkFlow has no such surface today. VS Code's rendered Markdown preview links instead go through `vscode.open(uri, { selection, viewColumn })` / direct `openEditor`, which does not pin the source — this is the model followed here.

## Consequences

- A window has at most one preview tab; all other tabs are pinned. The first document opened with a workspace is the preview tab.
- Following a rendered Markdown link from an unpinned tab reuses that tab; following it from a pinned tab adds a new preview. Links never pin their source (unlike VS Code code navigation), and each navigation is recorded in the global position history (ADR-0042).
- Tab rendering uses italic + localized tooltip/ARIA and exposes `固定 / Pin` only for the preview; sticky/UI Pin commands remain absent.
- ADR-0040 is amended: its per-tab state/handoff rules remain, but opening behavior follows ADR-0041, and transfer targets are always pinned.
- Tests follow the project pyramid: the slot state machine, open-mode decisions, and pin triggers get unit tests; Tab/TabBar rendering and keyboard/mouse affordances get component tests; only the user-visible sidebar single/double click, Enter, replacement, and cross-window result get e2e coverage.
