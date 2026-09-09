# ADR-0011: File names & extensions in the sidebar (inline create / rename)

- **Status:** Accepted
- **Decided:** 2026-09
- **Related:** ADR-0010 (sidebar folder filtering)

## Context

The sidebar names files in place: an inline input replaces the row for **rename**, and an extra row is
inserted for **New File**. Two problems were reported against that flow:

1. The rename input was pre-filled with the base name **without** its extension (`beta.md` → `beta`), so the
   extension was invisible — and whatever the user typed was forced back to `.md` on commit. Users could
   neither see nor change the extension, even though they may legitimately want a different Markdown one
   (`.markdown`, `.mdx`, …).
2. New File behaved the same way: the typed extension was stripped and `.md` was always appended.

The app can only open a fixed set of Markdown extensions (`MD_EXTS` in
`electron/main/lib/markdown-ext.ts`: `.md`, `.markdown`, `.mdx`, `.mdtxt`, `.mdtext`). Files outside that set
are never collected by the folder watcher, so silently writing one would produce a document the app cannot
re-open.

## Decision

- **The name input always shows the full base name, extension included.** What the user sees in the input is
  what lands on disk.
- **The typed extension decides the result, with three outcomes:**

  | Typed                                         | Result                                                                                                                                     |
  | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
  | `notes` (no extension)                        | `.md` is appended → `notes.md` (they simply forgot it)                                                                                     |
  | `notes.md` / `notes.markdown` / … (supported) | used **exactly as typed** — `.md` is never forced                                                                                          |
  | `notes.txt` (unsupported)                     | **refused**: nothing is written, the name is rewritten to `notes.md`, and the row **stays in edit state** for the user to accept or change |

- **Refusal is inline and non-blocking.** No dialog: the corrected name is offered in the still-open input,
  so the flow stays a single keystroke-confirm and the user is never told "no" without being shown the
  alternative.
- **Path separators are refused too** (folded to `-`, matching what the main process already does on
  create), so a rename can never escape into another directory.
- **One rule for both create and rename.** Both funnel through the same resolver, so the two entry points
  cannot drift apart.
- **The supported set stays single-sourced** from `MD_EXTS`; the renderer only reads it (via
  `markdownExtOf`), never re-declares it.

## Considered Options

- **Allow any extension the user types.** Rejected: it would let the app create files it can never open
  again, and the chokidar watcher (filtered by `MD_EXTS`) would never re-import them.
- **Silently coerce an unsupported extension to `.md`.** Rejected: the user's input would be changed behind
  their back, with no chance to notice. Refusing and _showing_ the correction keeps the user in control.
- **Block with a modal dialog.** Rejected: far too heavy for a name field, and it would break the inline
  "type and press Enter" flow.
- **Keep the extension hidden (status quo).** Rejected: it hides information the user is being asked to
  edit, and makes the resulting file name a guess.

## Consequences

- **Positive:** the file name is never a surprise; no unopenable files can be created; rename and create
  agree; the extension is a first-class, editable part of the name.
- **Negative:** the refusal is currently communicated only by the rewritten name in the input — a visible
  one-line hint naming the rejected extension is a proposed follow-up (needs one new i18n string). A
  degenerate bare `.md` name is accepted as-is rather than becoming `.md.md`.
