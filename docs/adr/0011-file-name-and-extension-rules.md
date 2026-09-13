# ADR-0011: File names & extensions in the sidebar (inline create / rename)

- **Status:** Accepted
- **Decided:** 2026-09
- **Related:** ADR-0010 (sidebar folder filtering)
- **Amended:** 2026-09 — duplicate and invalid names are **refused** (no `-N` suffix, no silent overwrite),
  the bare-name commit is **held** until a second Enter, and name comparison is case-insensitive off Linux.

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

A second round of problems was reported around **names that already exist**:

3. Creating a file whose name was taken silently produced `<name>-1.md` — the main process retried with an
   incrementing suffix, so the app invented a name the user never typed.
4. Creating a folder whose name was taken silently **succeeded** (`mkdir` was called with `recursive: true`,
   which swallows `EEXIST`), leaving the user believing a new folder had appeared.
5. A duplicate name was only discovered _after_ the commit was already in flight, and on macOS/Linux a
   `rename()` onto an existing target would **silently overwrite** it — data loss, not just a bad name.

## Decision

- **The name input always shows the full base name, extension included.** What the user sees in the input is
  what lands on disk.
- **The typed extension decides the result, with three outcomes:**

  | Typed                                         | Result                                                                                                                                     |
  | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
  | `notes` (no extension)                        | `.md` is appended → `notes.md`, but the commit is **held**; a **second Enter** creates it                                                  |
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
- **A name that already exists is refused, never renumbered.** The clash is detected **live** while typing,
  against the **complete** tree, so the commit is blocked before it is ever sent: red border, Enter does
  nothing, and a one-line hint says the name is taken. The main process is the **backstop**, not the
  decision-maker — `documents:create`, `documents:create-folder`, `documents:update` and both rename
  handlers all reject with `EEXIST` rather than inventing a `-N` suffix, silently swallowing the clash
  (the old `recursive: true` mkdir), or overwriting the target on POSIX.
- **Comparison is case-insensitive off Linux**, mirroring VS Code: its `diskFileSystemProvider` grants
  `PathCaseSensitive` only when `isLinux`, so on Windows/macOS `Note.md` and `note.md` are the same file and
  the clash has to be detected that way. The entry being renamed is excluded with the same folding, so
  changing only the case of its own name stays legal (VS Code's `child !== item`).
- **Folder names get VS Code's "invalid name" rule live.** A folder name carrying a separator or an
  OS-illegal character can never be written (`mkdir` is non-recursive, so `a/b` could only fail), so it is
  flagged as it is typed with its own message. **File** names keep the separator / extension verdict on
  Enter, because those rules would fire on every name on its way to a typed extension (`a.m` → `a.md`).
- **The new-folder input opens at the front of its level; the new-file input at the folder/file seam.**
  A folder being created shows before the first existing folder (where folders live), not after the last
  one; a file being created keeps the seam after the last folder, before the first file. The two slots are
  independent, so a folder and a file can be created at once (folder row on top, file row at the seam), and
  the same rule applies at every nesting depth.
- **Right-click menus agree on create order.** The folder-row menu lists **New Subfolder then New File
  Here** in one section (New File after New Folder), matching the blank-area menu, so the two "make
  something here" entry points cannot disagree.

## Considered Options

- **Allow any extension the user types.** Rejected: it would let the app create files it can never open
  again, and the chokidar watcher (filtered by `MD_EXTS`) would never re-import them.
- **Silently coerce an unsupported extension to `.md`.** Rejected: the user's input would be changed behind
  their back, with no chance to notice. Refusing and _showing_ the correction keeps the user in control.
- **Block with a modal dialog.** Rejected: far too heavy for a name field, and it would break the inline
  "type and press Enter" flow.
- **Keep the extension hidden (status quo).** Rejected: it hides information the user is being asked to
  edit, and makes the resulting file name a guess.
- **Renumber the name automatically (`notes-1.md`) on a clash.** Rejected (this was the behaviour): it
  writes a file under a name the user never typed, and they only find out by noticing.
- **Let the filesystem decide.** Rejected: `mkdir(recursive: true)` swallows `EEXIST`, so a duplicate folder
  silently "succeeded", and POSIX `rename()` **replaces** the target — silent data loss rather than a
  refused name.

## Consequences

- **Positive:** the file name is never a surprise; no unopenable files can be created; rename and create
  agree; the extension is a first-class, editable part of the name.
- **Positive:** no name the user did not choose is ever written — no `-N` fallback, no silent overwrite, no
  unopenable file — and every refusal now states its reason inline (`sidebar.unsupportedExt`,
  `sidebar.unsupportedName`, `sidebar.nameExists`, `sidebar.missingExt`, `sidebar.invalidName`,
  `sidebar.createFailed`) instead of leaving the user to guess from a rewritten input.
- **Negative:** a bare stem now takes **two** Enters (fill, then commit) where it used to take one. That is
  the price of never committing a half-typed name like `a.m` on the way to `a.md`.
- **Negative:** case-insensitivity is inferred from the **platform** (`navigator.userAgent` in the renderer,
  `process.platform` in the main process), not from the real filesystem capability as VS Code does. A
  case-sensitive volume on macOS, or a case-insensitive one on Linux, would be misjudged; doing it properly
  needs a real probe reported over IPC.
- **Negative:** a refused title change in `documents:update` surfaces through the pre-existing generic
  "Failed to save the file." alert, so it does not say the name was taken.
- A degenerate bare `.md` name is accepted as-is rather than becoming `.md.md`.
