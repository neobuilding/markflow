# ADR-0030: Extract the global toolbar into `GlobalToolbar.tsx`

The global (cross-pane) command bar — quick open, save / save-as / reload / file-details / export /
close — used to live **inline inside `EditorPane.tsx`** as a JSX const (`CommonToolbar`). It was folded
there by ADR-0024's D22, which deleted the dedicated `ui/titlebar.tsx` global bar to avoid introducing
a fourth horizontal chrome bar, and "borrowed" the `EditorPane` render body to host the single remaining
bar row. Functionally correct (it is a singleton, mounted once, outside the split), but a **separation-
of-concerns** smell: editor-pane code now carried app-level toolbar logic.

- **Status:** Accepted
- **Decided:** 2026-11-03
- **Supersedes:** nothing
- **Reverses:** the _implicit_ "no new component" stance of ADR-0024 D22 (the part that folded the
  global bar into `EditorPane`). The guard `src/renderer/src/components/ui/titlebar-deleted.test.ts`
  still forbids **reviving `ui/titlebar.tsx`** specifically; this ADR introduces a _new_ component, not
  a revival, so the guard is unaffected.
- **Amends:** `src/renderer/src/components/editor/EditorPane.tsx`, new
  `src/renderer/src/components/editor/GlobalToolbar.tsx`
- **Related:** ADR-0024 §2.8 (D22 deletion note), Q2a (the sidebar-toggle button was removed from this bar)

---

## 1. Requirement

| #   | Requirement                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| R-a | The global toolbar must be a **separate component**, not inline JSX inside the editor pane.                                              |
| R-b | The sidebar-toggle button is **removed** from this bar (Q2a); sidebar stays reachable via menu / ⌘\\.                                    |
| R-c | The meaty save/reload/close handlers stay owned by `EditorPane`; the new component receives them as **props**.                           |
| R-d | Only read-state the bar needs for _rendering_ (editable, dirty, active document, view mode) is read from the store inside the component. |

---

## 2. Evidence

- `App.tsx` mounts exactly one `<EditorPane />`, and the `global-bar` element lives **outside** the split
  container, so the bar was already a singleton — the coupling was purely a _file-placement_ smell, not a
  runtime duplication.
- The previous location mixed two concerns in one file: `EditorPane` (editor panel, drafts, split
  view, breadcrumb) and the app-level command bar. Extracting follows the VS Code pattern of keeping the
  title/global bar distinct from the editor group.

---

## 3. Decision

1. Create `GlobalToolbar.tsx`. It renders the `global-bar` row's inner toolbar and takes
   `{ onSave, onSaveAs, onReload, onClose, savePending, saveAsPending, reloadPending }` props; it reads
   `editable / dirty / activeDocumentId / viewMode` from `useUIStore` directly.
2. `EditorPane` renders `<GlobalToolbar ... />` at both the empty and document states (the two former
   `CommonToolbar` call sites), passing the local handlers.
3. The sidebar-toggle button is **gone** (Q2a). `editor.toggleSidebarShortcut` i18n key removed as dead.
4. `isEditableTarget` was hoisted to `lib/shortcut-scope.ts` (shared by `EditorPane` and `App.tsx`'s
   ⌘B guard) so the editor-pane-local copy could be deleted.

---

## 4. Consequences

- `EditorPane.tsx` is back to owning only editor-pane concerns; the global bar is independently
  testable and reusable.
- Handler logic (save/reload/close, including re-root and unsaved-switch guards) remains in `EditorPane`
  and is passed down — no behaviour change, no logic duplication.
- The `titlebar-deleted.test.ts` guard still passes: it bans `ui/titlebar.tsx`, not `GlobalToolbar.tsx`.
- Cost: a slightly larger prop surface on `GlobalToolbar`, accepted as the price of clean SoC.
