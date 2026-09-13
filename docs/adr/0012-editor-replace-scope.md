# ADR-0012: Editor replace only; sidebar replace deferred (preview is read-only)

The search surfaces were reviewed for a "replace" capability, referenced against VS Code. The
**preview pane is read-only and will never offer replace**, so it is permanently out of scope. The
decision below covers the editor (implemented now) and the sidebar find-in-files (deferred). The
editor reuses CodeMirror's native search panel, which already renders a replace field plus Replace /
Replace All buttons. Deferred items are tracked in `docs.local/plan-unified-search-ui-2026-09.md`.

- **Status:** Superseded by `docs/adr/0013-unified-search-ui.md` — its "reuse the native panel" decision is
  replaced (the editor gets a custom Find Widget). The preview-read-only and sidebar-replace-deferred
  decisions below carry over unchanged.
- **Decided:** 2026-09
- **Related:** `docs.local/plan-unified-search-ui-2026-09.md`

## Context

MarkFlow has three find surfaces: the CodeMirror editor, the rendered preview, and the sidebar
"find in files" (minisearch over the open folder). The user asked to add replace to all three,
VS Code-style. Findings:

- **Preview is read-only.** It is a rendered view of the source document, so it can never be an edit
  surface — replace is permanently out of scope there, not merely deferred.
- **Editor** already mounts `@codemirror/search`'s `search()` extension, whose default panel bundles a
  replace field and Replace / Replace All — i.e. editor replace is nearly free.
- **Sidebar find-in-files** replace needs new read-replace-write IPC plus match offsets that the
  current `search.query` result shape does not provide.

## Decision

- **Editor:** implement replace now by reusing the native CodeMirror search panel. Add `Ctrl/Cmd+H`
  (and a toolbar "replace" button) as entry points; the panel already offers Replace / Replace All and
  regex + `$1` capture-group replacement.
- **Preview:** read-only by design — **never** offer replace. Permanently out of scope.
- **Sidebar find-in-files:** do **not** add replace now. Defer to a full VS Code-style experience
  (replace input, per-file/per-match diff + replace, "replace all" with confirmation) once match-offset
  data and a write-back IPC exist.
- **Preserve case:** not implemented now; regex + capture groups are already available via the panel.

## Considered Options

- **Replace everywhere at once (full VS Code parity).** Rejected for this iteration: sidebar replace
  requires non-trivial new machinery (offset data + write-back IPC + diff UI) that would block the
  editor win; the preview is read-only and excluded regardless.
- **Custom replace UI instead of the native panel.** Rejected: the native CodeMirror panel already
  provides replace field + Replace/Replace All and integrates with the existing `Ctrl/Cmd+F` and
  `markdown:find` event plumbing, so a custom build would duplicate functionality for no gain.

## Consequences

- **Positive:** editor replace ships immediately with minimal code (entry-point wiring only); the shared
  `markdown:replace` event mirrors the existing `markdown:find` event and stays focus-agnostic.
- **Negative / deferred:** the sidebar still lacks replace; the deferred work (match offsets, write-back
  IPC, preserve-case) is catalogued so it is not silently dropped. The preview never gets replace, by
  design.
