# ADR-0032: Format-toolbar shortcuts — Italic / Link / Code / List / Task / Headings, and the format-key precedence policy

The round-3 review (ADR-0031) wired **only Bold** to a key (`⌘B`) and left the rest of the
formatting cluster click-only, noting in passing that Italic / Link "were never wired up". This ADR
completes that cluster and records the **policy** that decides who wins when a mainstream format key
collides with an existing MarkFlow app-command key.

- **Status:** Accepted
- **Decided:** 2026-11-04
- **Supersedes:** nothing
- **Reverses:** nothing
- **Amends:**
  - `docs/adr/0031-ui-round-3-shortcuts-overflow-and-menu.md` — its note that the Italic / Link
    shortcuts were not wired is now obsolete; this ADR completes the cluster it started.
  - `docs/adr/0024-ui-convergence-spec.md` — §3 item 2 ("no advertised-but-unimplemented bindings")
    and the global-bar inventory that still names `⌘K` / `⌘I`.
  - `docs/adr/0023-search-scope-and-specialized-surfaces.md` — the Quick Open chord.
  - `docs/adr/0013-unified-search-ui.md` — the `Ctrl/Cmd+K` palette reference.
  - `src/renderer/src/lib/format-shortcuts.ts` (new — the shared table),
    `src/renderer/src/App.tsx` (the format handler),
    `src/renderer/src/components/editor/EditorPaneBar.tsx` (glyphs + i18n tips),
    `src/renderer/src/components/editor/MarkdownEditor.tsx` (context-menu labels),
    `src/renderer/src/components/editor/GlobalToolbar.tsx` (`⌘K`→`⌘⇧K`, `⌘I`→`⌘⇧I` glyphs),
    `src/renderer/src/components/editor/CommandPalette.tsx` (`⌘K`→`⌘⇧K`, capture phase),
    `src/renderer/src/components/ui/tooltip.tsx` (hoverable content off, pointer events off),
    `electron/main/menu.ts` (File Details accelerator `⌘I`→`⌘⇧I`)
- **Related:** ADR-0031 (the `⌘B` / renderer-only precedent), ADR-0024 (UI convergence spec),
  ADR-0023 (search-surface scope), ADR-0029 (read-only default)

---

## 1. Requirement

| #   | Requirement                                                                                                                                                                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-a | **Italic `⌘I`, Link `⌘K`, Code `⌘E`, List `⌘⇧L`, Task `⌘⇧T`, Headings `⌘1..6`** are wired as renderer-only shortcuts that dispatch the same `markdown:insert` channel the toolbar buttons use.                                                |
| R-b | **Format keys take precedence over app-command keys.** When a mainstream format binding collides with an existing MarkFlow app-command binding, the format key wins and the app command relocates to a Shift chord. Applied now: `⌘I` / `⌘K`. |
| R-c | New format shortcuts are **renderer-only** (no native menu accelerator), consistent with ADR-0031's `⌘B`.                                                                                                                                     |
| R-d | **Underline is deliberately NOT bound** (`⌘U`) — Markdown has no underline semantics; recorded to prevent a future Word-parity addition.                                                                                                      |
| R-e | Every format action **advertises its own glyph** — on the toolbar button, in the narrow-mode overflow entry and in the editor's right-click menu — read from ONE table, so a label can never promise a key the handler does not implement.    |
| R-f | The relocated commands update their **visible glyphs** (`GlobalToolbar.tsx`) and **accelerators** (`menu.ts`) so on-screen hints match reality.                                                                                               |
| R-g | **One table owns the binding.** The key, the inserted markup and the advertised glyph live in a single pure module, so the handler, the tooltips and the context menu cannot drift apart.                                                     |

---

## 2. Evidence

- **Bold-on-`⌘B` is already the MarkFlow convention** (ADR-0031), deliberately following the
  Markdown-first editors (Typora / Obsidian / Bear / Zettlr) rather than VS Code. Italic `⌘I` and
  Link `⌘K` are the **same editors' universal pair** — Word, Google Docs, Obsidian, Typora and Bear
  all bind `⌘I` = Italic and `⌘K` = insert-link. Extending `⌘B`'s principle to them is the expected,
  not a novel, move.
- **Headings `⌘1..6`** is the Obsidian / Typora convention (Google Docs uses `Ctrl+Alt+1..3`); a full
  `⌘1..6` set — even for H2–H6, which have no toolbar button — matches what Markdown authors already
  expect from those editors.
- **List `⌘⇧L`** mirrors Word's `Ctrl+Shift+L` = bullet-list. **Task list has no mainstream
  precedent**, so `⌘⇧T` (T = task) is chosen because it is free in MarkFlow (no `⌘T` / `⌘⇧T` binding
  exists). **Code `⌘E`** is chosen as the free, mnemonic key (Obsidian uses `⌘E` for preview-toggle,
  but MarkFlow uses `⌘⇧P` for that, so there is no clash).
- **The collisions are real and were already noted.** `⌘I` was File Details (`menu.ts` accelerator +
  `GlobalToolbar` glyph) and `⌘K` was Quick Open (`CommandPalette.tsx` handler + `GlobalToolbar`
  glyph). Both are exactly the keys mainstream editors spend on Italic / Link, so the format keys win
  and the two app commands move to `⌘⇧I` / `⌘⇧K` (both currently free).
- **The right-click editor menu** (`MarkdownEditor.tsx`) previously omitted shortcut labels on the
  format items _precisely because_ `⌘I` / `⌘K` "were never wired up" (ADR-0024 §3 item 2). Those
  keys are now genuinely the formatting actions' own, so the labels become truthful and are restored.
- **CodeMirror's default keymap is the binding surface to check.** `defaultKeymap` is
  `[...].concat(standardKeymap)`, and it contains:
  - **`Mod-i` → `selectParentSyntax`** — a real collision with the new Italic binding. Our capture-phase
    handler wins, so `selectParentSyntax` becomes unreachable. That is the accepted cost of taking
    the mainstream Italic key.
  - **`Shift-Mod-k` → `deleteLine`** — a real collision with the **relocated** Quick Open chord. This
    one must not become a double action, so the Quick Open handler claims the key in the **capture
    phase** and stops propagation; the document is left untouched.
  - The emacs-style `Ctrl-e` / `Ctrl-k` / `Ctrl-t` bindings (`cursorLineEnd`, `deleteToLineEnd`,
    `transposeChars`) live in `emacsStyleKeymap`, which MarkFlow does **not** include — so `⌘E`,
    `⌘K` and `⌘⇧T` shadow nothing.
- **Capture phase settles ownership.** The format handler lives in `App.tsx`'s capture-phase window
  listener, like ADR-0031's `⌘B`. Capture precedes CodeMirror's own keydown (attached below `window`)
  and the handler `stopPropagation`s, so CodeMirror never sees the key — the mechanism that already
  keeps `⌘B` single-owned. `isEditableTarget` exempts `.cm-content`, so the key fires in the editor
  yet stands down in sidebar inputs and the find & replace widget; `hasModalSurface` stands it down
  while a modal owns the keyboard.
- **Digits are matched by physical position.** `⌘1..6` are read from `e.code` (`Digit1`…`Digit6`),
  not `e.key`, so the heading levels keep working on layouts whose digit row is shifted (on AZERTY
  `⌘1` would otherwise be `&`).
- **The insert channel is selection-preserving, never placeholder-injecting.** `markdown:insert`
  (toolbar button + keyboard shortcut) and the right-click menu share ONE implementation (`wrap`):
  with a selection the markers wrap it; with nothing selected the markers are inserted and the caret is
  parked between them — the mainstream Markdown-editor behaviour (Obsidian / VS Code / Typora) and
  crucially never a literal `text` placeholder in the document. A placeholder word would be a stray
  string the user must delete and was also hardcoded English (an i18n defect); caret-between avoids
  both.
- **Tooltips had to stop swallowing the pointer.** The shortcut glyphs are read by hovering along the
  format cluster, and Radix's default _hoverable content_ mode made that impossible: the open bubble
  intercepted the pointer (so the next button could be neither hovered nor clicked), and leaving a
  trigger armed Radix's "pointer grace area", which makes the **next** trigger ignore its
  `pointermove` — so the second tooltip in a row never opened. `disableHoverableContent` plus
  `pointer-events-none` on the bubble removes both. None of the app's tooltips carries an interactive
  control, so hoverable content bought nothing.

---

## 3. Decision

1. **One table owns the bindings** — `src/renderer/src/lib/format-shortcuts.ts`. For each action it
   holds the macOS glyph, the physical key, whether Shift is required, and the `before` / `after`
   markup. `matchFormatShortcut(event, isMac)` is a **pure** function over that table: it requires an
   exact match of modifier, Shift state and key, so `⌘⇧E` (Files view) and `⌘⇧F` (search in files)
   keep their keys and `⌘E` (code) does not steal them. The toolbar's tooltips and the editor's
   right-click menu read the same table, so a label cannot drift from the binding.
2. **Wire the six bindings** in `App.tsx`'s capture handler, each dispatching the editor's existing
   `markdown:insert` event with the same `before` / `after` the toolbar button uses:

   | Action | Key     | `before`          | `after`  |
   | ------ | ------- | ----------------- | -------- |
   | Italic | `⌘I`    | `_`               | `_`      |
   | Link   | `⌘K`    | `[`               | `](url)` |
   | Code   | `⌘E`    | `` ` ``           | `` ` ``  |
   | List   | `⌘⇧L`   | `-`               | ``       |
   | Task   | `⌘⇧T`   | `- [ ]`           | ``       |
   | H1–H6  | `⌘1..6` | `#`.repeat(n)+` ` | ``       |

   All are guarded by `isEditableTarget` + `hasModalSurface`, so they fire in the editor, stand down in
   text fields / modals, and are no-ops in read-only mode (the `markdown:insert` dispatcher already
   ignores read-only, matching the disabled format buttons).

3. **Format-key precedence.** When a mainstream format binding collides with an existing MarkFlow
   app-command binding, the format key wins and the app command relocates to a Shift chord. Applied
   now: `⌘I` = Italic (File Details → `⌘⇧I`), `⌘K` = Link (Quick Open → `⌘⇧K`).
4. **Renderer-only, no native accelerator** — identical to `⌘B`. Only the _relocated_ app commands keep
   their native footprint: `menu.ts`'s File Details accelerator moves `CmdOrCtrl+I` →
   `CmdOrCtrl+Shift+I`; Quick Open has no native accelerator (it is a renderer `CommandPalette` entry),
   so only `CommandPalette.tsx` and `GlobalToolbar.tsx` change for it. **No native item may claim
   `CmdOrCtrl+I` or `CmdOrCtrl+K`** — a native accelerator is consumed before the renderer sees the key.
5. **The Quick Open handler claims its chord in the capture phase** and stops propagation, so
   CodeMirror's `Shift-Mod-k` (`deleteLine`) cannot also act on it.
6. **No `⌘U` (underline).** Markdown has no underline semantics and the toolbar has no such button; the
   absence is explicit so a later "Word parity" impulse is rejected by this record.
7. **Visible glyphs stay truthful.** `FORMAT_BUTTONS` derives its markup and its glyph from the shared
   table and shows them through the existing `tipText` / `formatShortcut` interpolation; the editor's
   right-click menu advertises the four formatting items it now owns; `GlobalToolbar.tsx` updates its
   two glyphs (`⌘K`→`⌘⇧K`, `⌘I`→`⌘⇧I`).
8. **Headings `⌘1..6` full set.** H1 carries the `⌘1` glyph on its button; H2–H6 are keyboard-only
   (no button), consistent with Obsidian / Typora.
9. **Tooltips are informational only.** The provider sets `disableHoverableContent` and the bubble is
   `pointer-events-none`, so a tooltip never blocks the control beneath it.

---

## 4. Consequences

- Italic / Link / Code / List / Task / Headings become keyboard-accessible like mainstream Markdown
  editors — the formatting toolbar is no longer a mouse-only surface.
- **Breaking change.** `⌘I` and `⌘K` change meaning for existing users (File Details / Quick Open move
  to `⌘⇧I` / `⌘⇧K`). This needs **release notes**, the same treatment ADR-0031 gave `⌘B`.
- **Two CodeMirror commands become unreachable:** `selectParentSyntax` (`⌘I`) and `deleteLine`
  (`⌘⇧K`). Both are deliberate — the first is the price of the mainstream Italic key, the second the
  price of relocating Quick Open onto a chord CodeMirror already uses. `deleteLine` stays reachable
  through the usual editing keys.
- The editor's right-click menu now advertises `⌘B` / `⌘I` / `⌘E` / `⌘K`, so ADR-0024 §3 item 2 is
  satisfied again: the labels are implemented, not aspirational. All four formatting paths — the
  right-click menu, the toolbar button and the keyboard shortcut — share ONE insert implementation
  (`wrap`, reached by `markdown:insert` → `handleInsert` for the toolbar/shortcut), so an action
  behaves identically however it is triggered. With nothing selected the caret is parked between the
  markers (the mainstream Markdown-editor behaviour); there is no literal `text` placeholder. The
  `markdown:insert` no-selection behaviour is locked by `MarkdownEditor.test.tsx` (and the menu path
  by the `me-bold` no-selection case).
- The i18n surface grows by **six keys per locale** (`editor.fmt.*Shortcut`). The locale-parity test
  requires a zh-CN value to DIFFER from the English one (an untranslated key is a failure), so the new
  keys need real Chinese copy.
- The shortcuts are discoverable only if their glyphs can be read: the tooltip provider now disables
  hoverable content and the bubble is `pointer-events-none`. A tooltip covering the next toolbar
  button would make the glyphs unreadable — and would swallow clicks on the button beneath it.
- ADR-0031's passing note that Italic / Link were unwired is **obsolete**; this ADR supersedes it.
- The "format-key precedence", "renderer-only shortcut" and "format-shortcut table" terms are added to
  `CONTEXT.md`'s glossary.
