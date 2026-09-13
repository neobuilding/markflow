# ADR-0013: Unified search UI — shared find widgets, a redesigned search panel, and glob filename search

The three find surfaces had drifted apart: the editor showed CodeMirror's raw, unstyled search panel
(no i18n, bottom-anchored), the preview had a bespoke find bar whose "active match" had no styling at
all, and the sidebar palette's _filename_ mode rendered body snippets, so it looked like it searched
content. This ADR settles one coherent search language across all three, modelled on VS Code's three
reference surfaces, and adds glob matching to filename search.

- **Status:** Accepted
- **Decided:** 2026-09
- **Supersedes:** `docs/adr/0012-editor-replace-scope.md` (its "reuse CodeMirror's native search panel" decision)
- **Related:** `docs.local/plan-unified-search-ui-2026-09.md`

## Context

MarkFlow has three find surfaces plus one cross-document search panel:

| Surface             | Before                                                                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editor find/replace | CodeMirror's native panel: `search()` mounted with no config, zero CSS overrides, English-only, bottom-anchored                                                                           |
| Preview find        | A bespoke bar; matches relied on the UA `<mark>` default, and `preview-find-active` had **no CSS rule at all**                                                                            |
| Sidebar search      | A four-row palette; its _filename_ mode indexed `title` (the extension-less file name) correctly, but every result row still rendered a `content` snippet → it looked like content search |

VS Code's reference surfaces: the **Find Widget** (`Ctrl/Cmd+F`, floating, `k / n`, `Aa`/`ab`/`.*`/`AB`),
the **Search view** (sidebar: query + toggles + results grouped by file), and **Quick Open**
(`Ctrl/Cmd+P`, file name + dimmed relative path).

## Decision

1. **One visual language, shared atoms.** Extract `SearchInput`, `IconToggleGroup` (`Aa`/`ab`/`.*`/`AB`)
   and `MatchCounter` (`k / n` + ◀▶); each surface keeps its own container — the editor's lives inside a
   CodeMirror panel, the preview's is an absolutely-positioned React node, the sidebar's is a row in the
   search panel.
2. **Editor:** supply our own panel through `search({ createPanel })`, keeping CodeMirror's search
   _engine_ (find, replace, highlights, regex) but owning the UI, i18n and shortcuts. `Ctrl/Cmd+F` finds,
   `Ctrl/Cmd+H` finds-and-replaces; `k / n`, active-match emphasis, `Esc` to close.
3. **Preview:** find-only widget in the same visual language (replace stays permanently out of scope).
4. **Sidebar search panel:** one input line + an inline `文件名 / 正文` segment + a result list + a
   one-line shortcut footer. In **filename mode** a row shows the **file name + relative path** (never a
   body snippet); **content mode** keeps grouped body snippets.
5. **Glob filename search.** Filename mode accepts VS Code's glob syntax (`/`, `*`, `?`, `**`, `{}`,
   `[]`, `[!]`), implemented with `picomatch`. A query containing a glob metacharacter (`* ? [ {`) switches
   automatically to glob matching; a pattern **without** `/` matches the file name at any depth, one **with**
   `/` matches the path relative to the (single) open folder. Case-insensitive.
6. **No settings persistence.** None of the new toggles or modes are persisted — they reset on every
   launch, per the project-wide rule (see `docs/adr/0010-sidebar-folder-filter-toggle.md`).
7. **Shortcuts follow focus.** `Ctrl/Cmd+F` opens the find widget of the focused surface; `Ctrl/Cmd+H` is
   editor-only; `F3` / `Ctrl/Cmd+G` next, `Shift+F3` previous; `Esc` closes.
8. **Menu labels shortened:** `ctx.newFolderHere` and `ctx.newSubfolder` both read `新建文件夹`.

## Considered Options

- **Restyle CodeMirror's native panel via CSS + phrase translation.** Rejected: the panel cannot be made to
  match the app's visual language, and i18n is limited to CodeMirror's own phrase mechanism.
- **Hand-roll a glob→RegExp converter.** Rejected: supporting the full VS Code syntax by hand is _more_ code,
  not less, and it would sit inside the 100%-coverage gate.
- **`minimatch` instead of `picomatch`.** Rejected: `picomatch` is dependency-free and compiles a pattern to
  a matcher once (we match against many documents per keystroke).
- **An explicit "wildcard" mode.** Rejected: auto-detecting glob metacharacters is lower friction.
- **Persisting the toggles.** Rejected: forbidden — no settings are persisted.
- **Full VS Code parity (separate `files to include` / `files to exclude` boxes).** Deferred; glob is
  folded into filename mode for now.

## Consequences

- **Positive:** one coherent search language; editor replace gains i18n, `Ctrl/Cmd+F`/`H`, `k / n` and an
  emphasis on the active match; filename mode stops looking like content search; glob unlocks power queries
  (`**/*aa*.m*`); preserve-case (`AB`) ships with the custom widget instead of being blocked.
- **Negative / deferred:** sidebar cross-file replace is still unimplemented (it needs match offsets plus a
  read-replace-write IPC); `files to include/exclude` are not offered as separate boxes; ADR-0012's
  "reuse the native panel" decision is superseded.
