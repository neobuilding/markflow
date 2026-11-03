# ADR-0031: UI round 3 — ⌘B is Bold, ONE overflow, native menu order, dedicated search empty state

The round-3 UI review changed four things that ADR-0024 prescribed or implied. Each of them is a
**decision with a trade-off**, so they are recorded here together; ADR-0024 §3, §9 and §10 carry
amendment notes pointing at this ADR.

- **Status:** Accepted
- **Decided:** 2026-11-03
- **Supersedes:** nothing
- **Reverses:** ADR-0024 §3 item 1 (⌘B = toggle panel) and ADR-0024 §10's two-stage pane-bar
  collapse (`wide` / `folded` / `minimal`); ADR-0024 §9's list of what the empty-state global bar
  shows (it no longer contains a sidebar toggle)
- **Amends:** `src/renderer/src/App.tsx` (⌘B handler), `src/renderer/src/components/editor/EditorPaneBar.tsx`
  (single overflow), `src/renderer/src/components/editor/GlobalToolbar.tsx` (no sidebar toggle),
  `electron/main/menu.ts` (top-level order), `src/renderer/src/components/sidebar/SidebarSearch.tsx`
  (empty-state copy)
- **Related:** ADR-0024 (the UI convergence spec), ADR-0028 (theme entry), ADR-0029 (read-only
  toggle semantics), ADR-0030 (global toolbar extraction)
- **Completed by:** ADR-0032 — the cluster this ADR started (`⌘B` = Bold) was extended to Italic /
  Link / Code / List / Task / Heading, and the two keys that collided with app commands (`⌘I`,
  `⌘K`) moved to Shift chords. See ADR-0032's "format-key precedence".

---

## 1. Requirement

| #   | Requirement                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------- |
| R-a | **⌘B applies Bold.** It no longer folds the content panel.                                                                |
| R-b | The content panel is folded by *_⌘\*_ only, and ⌘B keeps **exactly one owner** (the renderer; no native accelerator).     |
| R-c | The pane bar collapses at **ONE** width threshold into a **single "…" overflow** whose entries all carry a visible label. |
| R-d | There is **no separate "Format" dropdown** and **no "minimal" stage** — one overflow, one threshold.                      |
| R-e | The native menu's top-level order is **文件 / 编辑 / 视图 / 窗口 / 语言 / 帮助** (Language after Window, Help last).      |
| R-f | The sidebar search's empty state uses **its own** i18n key instead of borrowing the command palette's.                    |
| R-g | The global bar carries **no sidebar-toggle button**; with no document open it shows only Quick Open + Close.              |
| R-h | The shortcuts stay **discoverable**: the activity-bar menu prints ⌘\, the Bold tooltip prints ⌘B.                         |

---

## 2. Evidence

- **Bold-on-⌘B is the Markdown-editor convention** (Typora / Obsidian / Bear / Zettlr all bind
  Ctrl/Cmd+B to bold). It is deliberately **not** called "VS Code parity": in VS Code Ctrl+B toggles
  the **bottom panel** (`workbench.action.togglePanel`, verified in the VS Code sources), which
  MarkFlow does not have, and the Markdown extension contributes no keybinding of its own. MarkFlow
  therefore spends the key on the editor's primary inline action instead of on a panel that does not
  exist.
- **One owner per key** is ADR-0024 §3's own rule; the reassignment keeps it (⌘B is renderer-only)
  instead of adding a second, competing owner.
- **A single overflow beats two stages.** The old model folded the format cluster into a `Format`
  dropdown first and only moved undo / redo / read-only into a "…" at a second, lower threshold. In
  practice the first stage already hid the seven formatting actions behind an **unlabelled**
  dropdown — the undiscoverable control the round-3 review was about. One threshold + one overflow
  removes the intermediate state entirely, and every overflow entry carries a visible label.
- **The threshold is a column width, not a viewport width.** The split ratio is user-draggable down
  to 0.2, so a viewport breakpoint can never describe the pane's width. `FOLD_AT = 420` is compared
  against the bar's **border box** (`borderBoxSize`), which equals the column width; the e2e
  environment contract (`e2e/guards/viewports.test.ts`) is derived from the same constants.
- **Menu order follows the platform convention**: 文件 / 编辑 / 视图 / 窗口 / 帮助 is the order every
  mainstream desktop app uses (macOS, Windows, VS Code); 语言 is a MarkFlow-specific top-level menu,
  so it sits after the platform's own menus and before 帮助, which is last by convention.
- **The sidebar search's empty state is a different surface from the command palette.** Reusing
  `palette.startTyping` made the sidebar speak the palette's words; a dedicated key
  (`sidebar.searchEmptyState`) lets each surface name itself, in both locales.

---

## 3. Decision

1. **⌘B = Bold.** `App.tsx`'s window handler dispatches the editor's existing
   `markdown:insert` event with `{ before: '**', after: '**' }` — the very same channel the toolbar's
   Bold button uses, so there is exactly one implementation of "bold". The handler stands down
   while a text field has focus (any `input` / `textarea` / contenteditable, including the editor's
   own find & replace widget) and while a modal surface owns the keyboard.
2. **⌘\ = fold the content panel** — unchanged from before, and now the only panel shortcut. The
   activity-bar right-click menu prints the shortcut, so the binding is discoverable without a
   button.
3. **One pane-bar threshold, one overflow.** `EditorPaneBar` measures its own border box and folds at
   `FOLD_AT = 420`: above it the twelve actions are inline; below it the WHOLE bar is one "…" menu
   whose twelve entries each carry a visible label (the seven format actions, find, replace, undo,
   redo, read-only switch). The `Format` dropdown and the `minimal` stage are gone.
4. **The native menu order is 文件 / 编辑 / 视图 / 窗口 / 语言 / 帮助.** The order is asserted by a
   unit test (`electron/main/menu.test.ts`), so a future reordering fails a test rather than a
   screenshot.
5. **The global bar carries no sidebar toggle.** The content panel is reachable from the
   activity-bar menu, the native 视图 menu and ⌘\.
6. **The sidebar search's empty state uses `sidebar.searchEmptyState`**; the command palette keeps
   its own `palette.startTyping`.

---

## 4. Consequences

- ⌘B is now the shortcut a Markdown author expects, and the sidebar shortcut is unambiguous.
- The pane bar has exactly two states, so there is no threshold that hides an action behind an
  unlabelled control; the visible-label rule also gives screen-reader users the action names.
- ADR-0024 §9's empty-state rule is now "Quick Open + Close" (no sidebar toggle), and ADR-0024 §10's
  two-stage collapse description is superseded by this ADR's single threshold.
- The old `⌘B` = toggle-panel binding is a **breaking change** and belongs in the release notes —
  the same treatment ADR-0024 §3 item 3 gave ⌘⇧E.
- The i18n surface grew by one key per locale (`sidebar.searchEmptyState`) and shrank by two
  (`editor.format`, `editor.toggleSidebarShortcut`).
