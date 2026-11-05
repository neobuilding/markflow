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
  **(Superseded by §5:** the single `FOLD_AT` threshold became a per-command budget; measuring the
  border box is still the rule.**)**
- **Menu order follows the platform convention**: 文件 / 编辑 / 视图 / 窗口 / 帮助 is the order every
  mainstream desktop app uses (macOS, Windows, VS Code); 语言 is a MarkFlow-specific top-level menu,
  so it sits after the platform's own menus and before 帮助, which is last by convention.
- **The sidebar search's empty state is a different surface from the command palette.** Reusing
  `palette.startTyping` made the sidebar speak the palette's words; a dedicated key
  (`sidebar.searchEmptyState`) lets each surface name itself, in both locales.

---

## 3. Decision

> **Superseded in part by §5 (2026-11-04):** item 3's single `FOLD_AT = 420` two-state fold no
> longer applies — both pane bars now overflow commands progressively and show "…" only while at
> least one command is hidden. Items 1, 2, 4–6 and the visible-label rule still stand. Flagged per
> `docs/agents/domain.md` (mark ADR conflicts explicitly rather than rewriting history).

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
  **(Superseded by §5:** the bar now has as many states as it has commands; the visible-label rule
  still stands.**)**
- ADR-0024 §9's empty-state rule is now "Quick Open + Close" (no sidebar toggle), and ADR-0024 §10's
  two-stage collapse description is superseded by this ADR's single threshold.
- The old `⌘B` = toggle-panel binding is a **breaking change** and belongs in the release notes —
  the same treatment ADR-0024 §3 item 3 gave ⌘⇧E.
- The i18n surface grew by one key per locale (`sidebar.searchEmptyState`) and shrank by two
  (`editor.format`, `editor.toggleSidebarShortcut`).

---

## 5. Amendment (2026-11-04): progressive priority+ overflow

R-c / R-d's "one threshold, the WHOLE bar folds at once" is superseded by a **progressive priority+
overflow**. `components/ui/priority-overflow.ts` budgets one 36px slot per icon tile and moves the
lowest-priority commands into the single "…" menu ONE AT A TIME as the column shrinks; at/above
`ALL_INLINE_AT` (472px for the twelve editor commands) no overflow is shown at all. Both pane bars
now use a **conditional overflow trigger**: the "…" button exists only while at least one command
has overflowed, so no command may depend on it as its only access path — Copy rendered HTML became
an ordinary, lowest-priority preview command instead of a resident menu entry. The single overflow,
visible labels on every entry, and the absence of a separate Format dropdown are unchanged.

Reason: an all-or-nothing fold made every command disappear (or reappear) at one pixel boundary.
Priority+ is the mainstream toolbar pattern (VS Code / Fluent / Radix-style navigation menus): show
as many items as fit and collapse the rest one by one, keeping the most-used actions reachable.
Verified against the local VS Code source (`src/vs/base/browser/ui/toolbar/toolbar.ts`): its
responsive mode pushes the "…" action only while `minimumWidth > containerWidth` and pulls it once
`hiddenActions` empties; one ResizeObserver on the container, a fixed per-action budget in
`kind: 'all'` mode, hiding from the array's end (`overflowFrom: 'end'`), and no debounce, binary
search or hysteresis. The e2e viewport contract derives from `ALL_INLINE_AT` instead of `FOLD_AT`;
the `FOLD_AT` references in ADR-0024 §10 and ADR-0026 describe the superseded two-state
implementation.

The chrome budget is **per bar**: the editor bar's 40px includes its format-group border and the
find/replace divider, while the preview bar has no separators and uses padding only (24px). Charging
both bars the same 40px made the preview overflow 16px too early (columns of 168–183px); the shared
calculation now takes the bar's own chrome. The named e2e environments import `ALL_INLINE_AT` from a
shared helper, and `e2e/guards/viewports.test.ts` asserts that helper matches the production budget.

The committed `chrome-visual` PNGs are **regression assets, not a design input**. When the wide
layout changes, `preview-pane-bar-e2e-app-win32.png` is re-captured from the new design; keeping a
resident menu merely to avoid re-capturing it would invert that relationship. The behavioral
assertions (trigger present/absent, one-at-a-time overflow) are the specification — the screenshot
only detects unintended drift. Re-capturing must be verified in the same run as the behavioural
assertions (`pane-toolbars`, `toolbar-density`, the viewport guard): pixel baselines must never be
used on their own to judge a behaviour change, and a re-capture whose cause is not understood must
be reported rather than silently merged.

### 5.1 Re-capture record (2026-11-04)

Three baselines were re-captured in this round: `editor-pane-bar`, `editor-pane-bar-dark` and
`preview-pane-bar`. Per the rule above, the cause is reported here rather than merged silently.

**Measured — each baseline compared against the current render, one at a time:**

| Baseline                  | Difference vs the committed PNG | Budget |
| ------------------------- | ------------------------------- | ------ |
| `editor-pane-bar` (light) | 340 pixels (1% of the image)    | 20     |
| `editor-pane-bar-dark`    | 300 pixels (1%)                 | 20     |
| `preview-pane-bar`        | 22 pixels (1%)                  | 20     |

Every figure is over the spec's 20-pixel budget, so the re-capture was REQUIRED: the rendered bars
changed, and this is neither font-rasterisation nor host drift.

**Localised to a segment, not to individual pixels:** the Playwright `diff` image for the light
editor bar shows the first seven format buttons as pixel-identical, with the difference confined to
the **trailing segment** (find / replace / undo / redo / read-only) — which rules out a whole-bar
layout shift. That segment is exactly what this round reworked: `EditorPaneBar.tsx` gained the
`group: 'format' | 'find' | 'editing'` model with its group separators, and the read-only button's
glyph became state-dependent (`editable ? PenLine : Lock`).

**Not established:** which individual button owns which of the 340 / 300 / 22 pixels. The diff
image was read visually to localise the segment; no coordinate-level mapping was produced, so the
residual attribution stays open.

**Verified in the same run as the re-capture:** `pane-toolbars` (behavioural assertions: trigger
conditionality, one-at-a-time overflow, focus hand-off in BOTH directions, the chrome budget
against the real layout), `toolbar-density`, `e2e/guards/viewports.test.ts` (the environment
contract) and `chrome-visual` itself — all green against the re-captured baselines.
