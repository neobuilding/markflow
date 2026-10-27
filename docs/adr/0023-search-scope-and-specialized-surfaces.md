# ADR-0023: Search scope visibility, specialized search surfaces, and cross-file replace

MarkFlow's cross-document search had drifted into a single `SearchPanel` that tried to be
both a file-name palette and a content search at once, behind a "current folder / all
documents" binary toggle whose two options were indistinguishable and silently changed
when the user drilled into a subfolder. Workspace root was being inferred from
`openFolders` (a file-watcher set that can hold several entries), and content matching
indexed `title + content + folderPath` together, so a title hit could surface a file with
no locatable body hit. Cross-file replace (deferred by ADR-0012) was never built. This ADR
settles the model with three specialized surfaces, a visible path-based scope, a single
authoritative `workspaceRoot`, content-only matching, and a safe replace service.

- **Status:** Accepted
- **Decided:** 2026-10-12
- **Revised:** 2026-10-13 — see "2026-10-13 revision" below (pattern classification, fail-closed
  invalid patterns, literal-phrase matching, dirty-buffer snapshots, real cancel IPC, planId
  one-time use, multi-root refusal) and "2026-10-13 third-round review" below (response-envelope
  additions, dirty-buffer ownership, atomic write, BOM fidelity, `markOwnWrite`, new main-process
  modules, two internal contradictions). The first folds in an independent review delivered that
  day, whose own D22–D26 numbering collided with the D22/D23 already in use and was folded in as
  amendments to decisions 2/3/4/5; the second is an implementation-layer review of the same date,
  recorded below as rulings 7–21. Both are restated in full here, so this ADR carries the complete
  wording on its own — nothing outside the repo is needed to implement it.
- **Revised:** 2026-10-16 — see "2026-10-16 ruling" below. The Replace All confirmation is
  enforced in the **UI only**; the frozen contract gains **no** credential field (ruling 31). This
  ruling changes no contract shape.
- **Revised:** 2026-10-17 — the "2026-10-15 planned future revision" (opt-in **regex**, **whole
  word**, and **`\n` line breaks** for the sidebar content mode) is now **IMPLEMENTED**: rulings
  22–30 below ship with the Search view's `.*` / `ab` toggles, the `invalid-regex` fail-closed
  diagnostic, Worker-isolated regex execution with a timeout `terminate()`, and the frozen
  contract's `regexp` / `wholeWord` options plus `SearchMatch.lineSpan`. Rulings 8 and 13 are
  amended accordingly: literal-phrase matching remains the **default**; regex and whole word are
  **opt-in**. A further `regex-timeout` diagnostic code (blocking, `field: 'query'`) was added
  with the Worker timeout and is recorded in the contract below.
- **Supersedes:** `docs/adr/0013-unified-search-ui.md` decision #9 ("resident sidebar search
  panel reuses the same `SearchPanel` as the `Ctrl/Cmd+K` palette — single source of truth")
  and ADR-0013 §3.8 ("default scope = active folder").
- **Resolves:** the sidebar cross-file replace deferral carried from
  `docs/adr/0012-editor-replace-scope.md` into `docs/adr/0013-unified-search-ui.md` ("Negative /
  deferred": sidebar replace still unimplemented; `files to include/exclude` not offered as separate
  boxes) — its two prerequisites (hit-offset data, write-back IPC) now exist, so both are no longer
  pending.
- **Related:** `docs/adr/0013-unified-search-ui.md`, `docs/adr/0012-editor-replace-scope.md`,
  `docs/adr/0010-sidebar-folder-filter-toggle.md`, `CONTEXT.md`. The working plans and review
  packages behind this ADR live outside the repository, so nothing binding is cited from them —
  everything an implementer needs is recorded below.

## Context

Four findings drove this:

1. **Invisible, ambiguous scope.** The binary `FolderOpen` / `Files` toggle could not be told
   apart from its icons/labels, and at the root both options were equivalent (an empty
   operation that still rendered). Following `activeFolder` silently narrowed results as the
   user drilled, with no on-screen signal.
2. **One component, two jobs.** `SearchPanel` served both Quick Open (file names) and the
   sidebar search via props, even though the result models differ fundamentally (flat
   file list vs. grouped body hits with offsets). VS Code and JetBrains keep these as
   separate surfaces for exactly this reason.
3. **Wrong root source.** `openFolders` (deleted — see Decision 3 below) was the watcher's
   monitored-directory set and could hold several entries; deriving the search root from it
   (e.g. `at(0)` / `at(-1)`) is undefined behavior.
4. **Mixed candidate source + no replace.** `contentSearch()` matched `title + content +
folderPath`, producing "title hit, no body hit" groups and inflating replace counts; and
   bulk write-back was absent (no body-level undo exists either — `documents:undo-rename` only).

## Decision

1. **Three specialized surfaces, no unifying mode switch.**
   - **Quick Open** (`Ctrl/Cmd+K`): file **name + relative path** only, flat list, no scope,
     no replace. Reuses the existing filename glob behavior (ADR-0013 #5).
   - **Search view** (sidebar, `Ctrl/Cmd+Shift+F`): **Markdown body content only**, with
     include/exclude scope and cross-file replace.
   - **In-place find** (editor / preview, existing shortcuts): locates within the current
     pane only; never mixed with workspace search.
     Extract a shared presentation-only `SearchResultList`; delete `SearchPanel`'s dual-mode
     branching (supersedes ADR-0013 #9).

2. **Scope is a visible path pattern, not a mode bit.** Two editable text rows,
   `include` / `exclude`, resolved against the **single `workspaceRoot`**. The comma-separated
   list is split with a **glob-aware tokenizer** (braces `{}` and character classes `[]` keep
   their commas — `split(',')` would break `*.{md,mdx},./docs` and the valid class `[ab,c].md`;
   VS Code uses the same approach, `glob.ts` `splitGlobAware`). Patterns are then **classified**
   before matching: a **path-type** pattern (absolute, or starting with `./`, `../`, `.\`, `..\`)
   expands to `p` and `p/**`; an ordinary **glob** expands to `**/p/**` and `**/p` — never a
   blanket `p + '/**'` (that misses `a/b.md` for `*.md` and any-depth `docs` for a bare `docs`).
   Empty means the whole root. **Non-empty scope is always visible** (auto-expand the details
   region); it is never hidden by folding (mirrors `searchView.ts:599-601` / `1580-1583`). Tree
   right-click "Find in Folder" sets `include` to `./<subpath>` and focuses; the root-folder
   item **clears `include` only**, preserving any user-set `exclude`. Include/exclude matching is
   **not** the Quick Open matcher: the `basename:` match-base rule (`electron/main/ipc/glob.ts`)
   stays exclusive to file-name search (ADR-0013 #5), because the two answer different questions.
   **An invalid pattern blocks** both query and replace: the query returns a blocking
   `invalid-pattern` diagnostic (field + pattern + message) and clears previous results, and the
   replace plan fails with zero writes — dropping a bad pattern would silently _widen_ the scope
   the user asked for. (picomatch compiles malformed patterns without throwing unless
   `strictBrackets` is set, and even then a stray closing `}` is accepted, so validation is
   explicit: `strictBrackets` plus a brace-balance check.)

3. **Single authoritative `workspaceRoot`.** `workspaceRoot: string | null` is the only root;
   set by open-folder / open-file / close-workspace, cleared on close. **Search IPC must not
   read `openFolders`.** The watcher's monitored set survives only transitively and is **removed in a
   staged change**: once `createWatcher()` reads `workspaceRoot` directly,
   `electron/main/model/openFolders.ts` and its unit tests are deleted and `documents:set-open-folder`
   becomes `documents:set-workspace-root`. That removal also fixes a latent leak in which renaming the
   root folder left the old path in the set forever. **Opening a folder replaces the workspace**
   (clear document store + clear the root + set the new root), so at most **one** root is ever
   watched. **Multi-root workspaces are permanently out of scope**
   (single-window app; no "add folder to workspace"). Opening a single `.md` file roots at the
   file's **parent directory**. **Single-root invariant:** every document in the store must live under
   `workspaceRoot`; open/import (including multi-directory drops and command-line paths) must be
   confined to the one root — out-of-root paths are rejected with a notice rather than imported, so
   `relativePath` is always defined. **Save As to a path outside the current root re-roots after
   explicit confirmation**: confirm → save → replace `workspaceRoot` with the target
   file's parent directory, keep the document, clear the old workspace; cancel or a failed save
   leaves the root and workspace untouched.

4. **Content-only candidate set.** Search-view results are decided by literal body hits in the
   `content` field only; `title` and `folderPath` no longer contribute (supersedes ADR-0013
   §3.8's implication that they do). Quick Open owns name/path lookup. Search and replace
   share one literal matcher (counts, UTF-16 code-unit offsets — never code-point offsets), so
   statistics and replace plans agree. The matcher treats the **whole query string as one literal
   phrase**: spaces belong to the query, there is no word splitting and no implicit AND/OR — the
   same contract ripgrep gets via `--fixed-strings`
   (`node/ripgrepTextSearchEngine.ts:498-501`). MiniSearch, if retained, may only _rank_ already-hit
   files, never expand the candidate set. **Memory-only drafts participate only when scope is
   empty**; when any include/exclude pattern is set they are excluded (they have no relative path
   against the root). **Without a `workspaceRoot` there is no disk candidate set, so drafts are
   still searched** (VS Code likewise searches dirty/untitled editors); only the scope controls
   are disabled, and drafts never enter a disk replace. **The same premise applies to dirty disk
   documents**: an open document with unsaved edits is searched from its **current buffer**, not
   from the stale on-disk bytes, so what the user sees as searchable is what replace can act on.

5. **Safe cross-file replace as a plan/apply/undo service.** `search:replace:plan` builds the
   full candidate set (independent of UI caps `MAX_MATCHES_PER_DOC=50` / `MAX_RESULT_DOCS=200`;
   those caps must never bound the replace), reads disk bytes, flags unsaved content, and
   returns a plan + counts without writing. **Planning is asynchronous, per-file, and
   cancellable**: it must not block the main process, and cancellation travels over a **real IPC
   channel** — `search:replace:cancel({cancelToken})` backed by a main-process registry of active
   plans / `AbortController`. A `cancelToken` in the request alone is _not_ cancellation: IPC is
   one-way, so the renderer cannot interrupt a scan that is already running. Both cancellation
   and safety abort leave **zero bytes written**. The plan is guarded by five
   **fixed, non-configurable** safety constants: `MAX_REPLACE_FILES = 1000`,
   `MAX_REPLACE_TOTAL_INPUT_BYTES = 64 MiB`, `MAX_REPLACE_FILE_BYTES = 16 MiB`,
   `MAX_REPLACE_OUTPUT_BYTES = 128 MiB`, `MAX_REPLACE_COUNT = 100_000`. The output budget is
   measured on the **encoded bytes of the buffer that would actually be written** (original
   encoding, BOM, line endings) — never on a JavaScript string-length approximation. Exceeding
   any one of them aborts the whole plan (never truncates) and reports the **offending files** so
   the user can narrow the scope; nothing is written. They are constants, not settings, because no
   mainstream editor exposes bulk-disk-replace safety limits to users — the escape hatch is
   narrowing `include` and replacing in batches, not raising the number.
   `search:replace:apply` re-verifies file version/hash (`baselineHash = sha256(buffer)`; mtime is
   unusable because the in-memory `stat().mtimeMs` is always 0) — skip + report conflict on
   external change — writes per file via the project's safe/atomic
   path, preserves encoding/BOM/CRLF, and reports per-file status (success/skip/conflict/failure).
   `search:replace:undo` restores the last transaction, skipping files changed since. Replace All
   requires explicit confirmation (N occurrences / M files / replacement text); empty replace text
   deletes; empty query is rejected. Unsaved disk files are **skipped with a prompt** (do not
   auto-save); pure memory drafts never participate in disk replace. **Unsaved state must be
   reported by the renderer**: the main process cannot infer it, because the store's `content`
   _is_ the on-disk bytes, so a read-and-compare would always report "unchanged" and silently
   overwrite user edits. Replace therefore takes a **required** `unsavedDocumentIds` (all dirty
   documents, not just the active one) plus a monotonic `documentStateRevision`; apply re-reads
   both and aborts the whole transaction, before any write, if they changed. A `planId` is
   **one-time** and bound to the root, session, query, replacement, scope, match-case and dirty
   revision; a repeated apply is refused. Query results are returned in an envelope
   (`{ results, diagnostics, appliedScope, truncated }`) with `matchCount`/`matchCapped`/`relPath`
   per result, so >50 hits still display the true count. Content queries additionally require
   `dirtyDocumentSnapshots` so unsaved buffers are searched as they are. An invalid include/exclude
   pattern is **fail-closed on both sides**: the query returns a blocking `invalid-pattern`
   diagnostic and clears previous results, and replace aborts with zero writes — dropping the bad
   pattern would silently _widen_ the scope the user asked for.

6. **Case handling, per VS Code.** A **Match Case (`Aa`) toggle** for body content, default
   **off** (case-insensitive), exactly as VS Code (its Search view carries the same toggle:
   `constants.ts` `ToggleCaseSensitiveCommandId`, `searchView.ts` `toggleCaseSensitive()` /
   `isCaseSensitive`, defaulting to false). Include/exclude **path glob** matching uses
   **uniform case-insensitivity** (documented, not platform-derived) to keep Windows/Linux CI
   behavior deterministic (see `docs/agents/testing.md`).

7. **UI structure.** Sidebar **File view and Search view are mutually exclusive** (File view
   shows the tree; Search view shows the search box, scope, and results — never both). Three
   toolbar tiers (global / editor / preview) with stable positions; split view shares one local
   tool row. Quick Open is a **compact trigger**, not a resident title-bar input field — VS Code's
   own Command Centre is likewise a button-like toolbar action carrying a search icon, hidden
   while the quick input is open (`commandCenterControl.ts` `MenuWorkbenchToolBar`). The
   **global toolbar is the editor pane's always-present tool row** (`EditorPane.tsx`
   `CommonToolbar`, rendered both with and without an active document): the trigger sits there,
   immediately right of the sidebar toggle, so it stays visible with the sidebar closed and with
   no document open. **No extra top bar is added** — a fourth horizontal strip plus duplicate drag
   regions (`Sidebar.tsx` / `EditorPane.tsx` headers) was rejected, and the dead
   `ui/titlebar.tsx` is deleted instead. Every entry names its range in its label/tooltip
   (Go to file / Search in files / Find in document / Find in preview).

8. **State is session-only.** `searchInclude` / `searchExclude` / `searchReplaceOpen` /
   `searchDetailsOpen` / query / replace text live in `useUIStore`, preserved across File/Search
   view switches, reset on `closeWorkspace`, never persisted (project-wide rule, ADR-0010).

9. **One guarded door for switching documents.** MarkFlow keeps a **single active document**
   whose unsaved buffer lives only in the editor instance, so switching away destroys edits with
   no backup — the main process's stored `content` _is_ the disk bytes. Every document switch
   therefore goes through store-level `selectDocument(id)` / `openDocumentAt(id, start, end)`,
   which prompt while `dirty` and resolve to `false` — no switch, no `pendingMatch` — when the
   user keeps editing; `setActiveDocumentId` is demoted to a **raw** setter for internal resets
   and already-confirmed flows. The guard covers tree clicks, sidebar search results, the
   `Ctrl/Cmd+K` palette, jump-to-match, document creation and "switch to next after delete" —
   today only the tree click is guarded, the other six paths silently discard edits. Side effects
   come **after** the prompt, so creating a document asks first and a cancelled switch leaves no
   orphan draft. VS Code needs no such prompt because it keeps a dirty working copy per editor
   (`files.hotExit` defaults to `onExit`; `window.confirmBeforeClose` defaults to `never` on
   desktop); preserving per-document unsaved state is out of scope here (single active document
   plus manual save, ADR-0012) and recorded as follow-up. The confirmation **names the document
   being left**, and focus returns to the editor when the user keeps editing.

## Consequences

- The old "current folder / all documents" toggle and its i18n keys are removed; include/exclude
  replace them.
- `Ctrl/Cmd+K` no longer searches body content; body search is the sidebar only (a behavior change
  to call out in release notes, consistent with VS Code).
- `activeFolder` (sidebar drill state) no longer affects search scope in any way.
- Opening a folder now _replaces_ the workspace rather than accumulating — also fixes the latent
  bug where dropping several disjoint folders registered only `directories[0]` with the watcher.
  Opening/dropping **several disjoint directories at once is refused** (nothing imported, no root
  set, the previous workspace untouched) with the candidate roots listed for the user to open one
  at a time; when the dropped directories share a common ancestor, that ancestor becomes the root
  and the user is told. Picking `directories[0]` silently is forbidden — it is an arbitrary choice
  that depends on OS drop order, and registering several roots would break the single-root
  invariant.
- Once the watcher reads `workspaceRoot` directly, `openFolders.ts` plus the
  `documents:set-open-folder` / `documents:clear-open-folders` IPC surface are removed. That is a
  **breaking change to the preload contract and its e2e guard test**, done in one
  staged step; in return the duplicate "root" concept disappears and a latent leak is fixed (renaming
  the root used to leave the old entry watched forever). Renaming the root now re-points
  `workspaceRoot` and rebuilds the watcher instead.
- Memory drafts are excluded from scope-filtered search and discarded on workspace replacement.
- Bulk replace gains confirm + real counts + version-conflict protection + encoding preservation
  - partial-failure reporting + session undo, with no body-level undo to fall back on.
- An invalid include/exclude pattern **blocks** both query and replace (the query clears previous
  results rather than silently widening the scope); the confirmation names the document being left;
  the output budget is measured on the encoded bytes of the buffer that would actually be written,
  never on a JavaScript string-length approximation.
- Content queries and replace plans must carry **dirty-buffer snapshots plus a monotonic
  `documentStateRevision`**; the query/replace input size now grows with the number of open dirty
  documents (acceptable for Markdown-sized documents; a main-process buffer mirror is the fallback
  if that stops being true).
- Cancel is a **real IPC channel** (`search:replace:cancel`) backed by a main-process task
  registry; a `cancelToken` in the request alone is not cancellation. `planId` is one-time and
  bound to the root, session, query, replacement, scope, match-case and dirty revision.
- The Quick Open trigger moves from the sidebar header to the editor pane's always-present tool
  row; the sidebar magnifier and the dead `ui/titlebar.tsx` (+ its test) are removed, and **no new
  top bar is introduced**.
- Document switching collapses to one guarded store entry point (`selectDocument` /
  `openDocumentAt`); `setActiveDocumentId` becomes a raw setter for internal use, which is a
  breaking change for any renderer code that called it directly.

## 2026-10-13 revision

An independent review delivered 2026-10-13 found six places where the 10-12 wording was either
factually wrong about VS Code or unimplementable as written. Each is folded into the decisions above
and restated in full as the six items below (the review's own D22–D26 numbering collided with the
D22/D23 already in use and was renumbered).

1. **Literal phrase, not word splitting.** VS Code hands the whole query to ripgrep as
   `--fixed-strings` (`ripgrepTextSearchEngine.ts:498-501`); the earlier "split on whitespace"
   wording was wrong and inflated replace counts.
2. **Pattern classification.** VS Code expands a _path-type_ pattern (`./work`) to `p` + `p/**`,
   and an ordinary glob to `**/p/**` + `**/p` (`queryBuilder.ts:362-404`, `:534-539`, `:653-660`).
   A blanket `p + '/**'` misses `a/b.md` for `*.md` and any-depth `docs` for a bare `docs`.
3. **Glob-aware list splitting.** `split(',')` breaks `*.{md,mdx},./docs` and the valid character
   class `[ab,c].md`; VS Code splits with `splitGlobAware` (`glob.ts:66`).
4. **Fail-closed invalid patterns.** Dropping a bad pattern removes a narrowing condition and
   silently widens the search; the query now blocks and clears results instead of failing open.
   picomatch needs `strictBrackets` (plus a brace-balance check) before invalid patterns are even
   detectable — verified against the installed version.
5. **Dirty buffers are searched.** Unsaved content participates in content search via
   `dirtyDocumentSnapshots` + `documentStateRevision`; an ID list alone cannot search text the main
   process has never seen.
6. **Cancel is real IPC.** `search:replace:cancel` plus a main-process task registry; a token in
   the request cannot stop a running scan.

Also revised: `planId` is one-time and fully bound; the output budget is measured on encoded bytes;
opening/dropping several **disjoint** directories is refused with the candidates listed (a shared
common ancestor becomes the root); and the narrow TOCTOU window between the last hash check and
the atomic commit is stated rather than claimed away.

## 2026-10-13 third-round review (implementation-layer rulings)

A second, later review (same date) re-audited the design against the code (`file:line`) and found 22
gaps the design had _decided_ but not specified enough to implement. It changes none of the
decisions above. The rulings below are recorded here because they are **binding at implementation
time** and are not restated anywhere else.

Additions to the frozen response envelope (`shared/searchTypes.ts`):

7. `SearchResult` keeps **`filePath: string`** (absolute on-disk path; `''` for an in-memory draft).
   Removing it broke the context menu's "copy result path", which must copy an absolute path
   (`SearchPanel.tsx:68-81`). `folderPath` is deliberately **not** restored — it is the dirname of
   `relPath`.
8. **Ordering is deterministic.** Literal-phrase matching has no relevance score, so the old
   `b.score - a.score` cannot exist: content mode sorts by `relPath` ascending (drafts, whose
   `relPath` is `null`, sort last by `title`); filename mode keeps `title.localeCompare`. Must be
   identical on Windows and Linux CI (`docs/agents/testing.md`).
9. **`path-not-found` is `blocking: true`** (results must be empty). Answering with whole-root
   results is exactly the silent scope widening that fail-closed (decision 4) forbids. 10. **`no-workspace-root` blocks only when there is no root _and_ `include` or `exclude` is
   non-empty.** No root with an empty scope is the legitimate "search in-memory drafts" case and
   returns no diagnostic.
10. `drafts-excluded` and `out-of-root-skipped` are both `blocking: false`;
    `out-of-root-skipped` is emitted only when such a document was actually skipped (count > 0).
11. **`truncated` and `matchCapped` are distinct.** `truncated` = the candidate **document** count
    was capped by `MAX_RESULT_DOCS`; `matchCapped` = a single document's `matches` was capped by
    `MAX_MATCHES_PER_DOC`. The UI reads `matchCount` for display, never `matches.length`.
12. **`search.multilineUnsupported` does not enter the envelope.** A query containing CR/LF never
    issues an IPC call and is intercepted renderer-side with an inline hint — it is not a scope
    diagnostic and must not occupy the blocking envelope. (This revises the i18n key list, which had
    added it as an IPC key.)

Ownership of the dirty-buffer snapshot (the design's largest gap — the contract said only "reported by the renderer"):

14. `dirty` is a single global boolean (`ui.ts`) fed by `useLocalDocument`; MarkFlow has one active
    document and therefore at most one in-process buffer. A new store slice owns the data:
    `unsavedBuffers: Record<string, { content: string; revision: number }>` plus a global
    `documentStateRevision`, mutated **only** inside `reportUnsavedBuffer` / `clearUnsavedBuffer` so
    the four trigger points (content change, dirty flip, document added, document closed) cannot be
    missed; `documentStateRevision` is additionally bumped in the create/delete document success
    callbacks.
15. Known trade-off (not a defect): §5.2 lets unsaved buffers be searched while §5.5.3 makes replace
    skip unsaved files, so a user can find text they cannot yet replace. Surfaced as the
    `dirtyBufferSkipped` diagnostic rather than hidden — concretely, `ReplacePlanSummary.skipped`
    already carries every skipped file with its reason, and the Search view renders the
    `unsaved` / `out-of-root` reasons next to the plan count (`search.dirtyBufferSkipped`,
    `search.outOfRootSkipped`); `no-hit` is deliberately not surfaced.

Main-process prerequisites the design assumed but that did not exist:

16. **`DiskIO.writeFileAtomic(path, data)` is new**: same-directory temp file + `rename` (a rename
    across devices is a copy and would not be atomic); `createMemoryDiskIO` implements the same
    signature so tests assert bytes, not choreography.
17. **BOM fidelity** is handled by the replace service sniffing the buffer it already read
    (`EF BB BF` / UTF-16 BOM) and re-prefixing it on write-back. `Document` gains **no** `hasBom`
    field.
18. Replace writes call **`markOwnWrite(filePath)` per file**, otherwise the watcher echo would read
    a replace result back as an external modification. Replace does **not** reuse
    `documents:update`'s write path (it carries title-rename / EEXIST / wordCount logic); it uses
    `DiskIO` directly while sharing `markOwnWrite` and same-directory atomic replacement.
19. New modules the design assumed but that did not exist: `electron/main/service/replace.ts` (pure
    service; IPC only validates and forwards), `lib/hash.ts` (`sha256(buffer)`, **not** `mtime`,
    because `createMemoryDiskIO` has no real mtime semantics), and
    `electron/main/model/workspaceRoot.ts`
    (`getWorkspaceRoot` / `setWorkspaceRoot` / `getWorkspaceSession`).

Internal contradictions, and how they are resolved:

20. Two places disagreed: the acceptance checklist said "File and Search mutually exclusive views"
    while the implementation steps only removed the sidebar magnifier. The mutually exclusive views
    are implemented **in this change** — the scope rows plus result list cannot fit above a 240px
    sidebar, and the layout was already settled in the UI redesign. `residentSearchCollapsed` is
    therefore deleted.
21. "No new renderer-side root state" vs "disable include/exclude when there is no root": no new
    root state is added, and the disabled state is derived from the renderer's
    existing `activeFolder` rather than from the envelope's `appliedScope.root`. **Deliberate
    deviation from the review's ruling:** an empty query never issues a search, so
    `appliedScope.root` is unknown precisely _before_ the user has typed — deriving from the
    envelope would leave the controls permanently disabled.

## 2026-10-15 planned future revision — regex, whole word, multiline (IMPLEMENTED)

> **Status: implemented (2026-10-16, on `feature/unified-search-ui`).** Everything below is now in
> the code: `shared/searchTypes.ts` carries `regexp`/`wholeWord` on both query and replace options,
> `lib/content-match.ts` + `lib/word-boundary.ts` implement opt-in regex + UAX #29 whole word,
> `ipc/search.ts` routes regex through a Worker (`service/regex-runner.ts` + `service/regex-scan.worker.ts`,
> D37), and `service/replace.ts` binds the match semantics into the plan. Single-process fallback
> when the Worker cannot start (D37). Full design: rulings 22–30 below.

The sidebar content mode (cross-file search) is literal-only today, while the editor and preview
find surfaces already have regex (ADR-0013 decision 2, `lib/find-toggles.ts`). That gap was
deliberate — the 2026-10-13 revision item 1 ("literal phrase, not word splitting") — and both regex
and multiline were listed as future capabilities. On 2026-10-15 the direction was reversed.

22. **The literal-phrase decision is amended when this ships, not before.** Content matching stays
    **literal by default**; regex becomes an **opt-in mode** (`regexp`, default off). Its hard
    requirement — that search, count, offsets and replace share one matcher — is unchanged. Until
    this ships, that decision stands as written and rulings 8 and 13 remain in force.
23. **Regex is content-mode only.** Filename mode keeps glob (ADR-0013 #5), so a
    query's `*`/`?` are ordinary characters outside regex mode.
24. **`\n` is a regex-mode escape, not a raw newline.** In regex mode a literal `\n` (two
    characters) expands to `(?:\r\n|\r|\n)`, so LF, CRLF and lone-CR documents all match. The
    haystack is **never** normalised: offsets must stay UTF-16 offsets into the original text
    (§5.4), and normalising would shift them. Literal mode stays strictly literal — `\n` there is
    backslash + n.
25. **The renderer-side multiline interception (ruling 13) stays as is.** It blocks a _raw_ CR/LF
    character in the query; regex mode uses the two-character escape, so the two never conflict.
    All three layers (renderer guard, inline hint, main-process backstop) are untouched.
26. **Invalid regex fails closed**: new blocking diagnostic `invalid-regex` with `field: 'query'`,
    results cleared. It must **never** degrade to a literal search — same rationale as decision 4
    (never silently widen or change). It is a _query_ diagnostic, distinct from the _scope_
    diagnostic `invalid-pattern` (`field: include|exclude`); both share the `diagnostics` array and
    are told apart by `code` and `field`.
27. **Whole word = UAX #29 word-boundary alignment**, judged with `Intl.Segmenter`
    (`granularity: 'word'`), and **no special case for Han**. Standard `\b` semantics: both ends of
    the match land on a word boundary — _not_ "exactly one segment".
    - Verified on Node v22.23.2 (full-icu): `这是中文文本` segments as `这@0 是@1 中文@2 文本@4`.
      ICU ships a Chinese dictionary, so `中文` **is** one complete segment and **matches**, while
      `文文` (spanning two segments) does **not**. Whole word therefore genuinely works for Chinese,
      Japanese (`食べる` in `食べることが`) and Latin alike.
    - Do **not** use `\w`: Han is not `\w`, so the toggle silently no-ops (this is precisely VS
      Code's behaviour). Do **not** use a bare `\p{L}` either: Han _is_ `\p{L}`, so it never
      matches. The two fail in opposite directions.
    - Segmentation is driven by the **script of the text, not the locale** (identical output under
      `en` and `zh`), so no locale needs to be chosen.
    - Prerequisite: the main-process Node must be **full-icu**, or dictionary segmentation is lost,
      Chinese degrades to per-character, and the toggle silently becomes a no-op.
28. **User regex must not run on the main thread.** JS `RegExp` is backtracking and cannot be
    interrupted mid-run (`AbortController` cannot reach it), so execution goes into a **Worker**
    with a timeout and `terminate()`, plus an input-length cap. Reference point: ripgrep and Rust's
    `regex` crate are finite-automata based and linear-time by construction — VS Code inherits that
    guarantee by delegating to ripgrep; JS has no such builtin. The threat model here is
    _accidental_ (the user writes their own regex), not adversarial, so replacing the engine is
    disproportionate.
29. **Frozen contract deltas** (every shape change must be mirrored in
    `shared/searchTypes.ts` and here, or the renderer and main process drift):
    `SearchQueryOptions.regexp?: boolean`, `SearchQueryOptions.wholeWord?: boolean`,
    `SearchMatch.lineSpan: number` (lines a match spans; `1` in literal mode — required because
    `excerpt` is truncated at `EXCERPT_MAX` and cannot convey the true span), and `SearchDiagnostic`
    code `invalid-regex`. Replace options must carry `regexp` / `wholeWord` and bind them into the
    one-time `planId`.
30. **Out of scope for this item:** filename-mode glob, the existing multiline interception layers,
    and D24's default-literal semantics.

## 2026-10-16 ruling — the replace confirmation is UI-enforced

Cross-file replace is the app's only destructive bulk write, and Replace All asks for a second
confirmation (`N 处 / M 文件 / 替换为 X`). The obvious reading is that such a confirmation should be
_enforced by the main process_ through a credential field on `search:replace:apply`. It is not.
This ruling records why — the field was proposed, pulled, and proposed again, so the rejection is
worth remembering.

31. **The confirmation lives in the UI; the frozen contract carries no credential.**
    `ReplaceApplyOptions` is exactly `planId` / `unsavedDocumentIds` / `documentStateRevision`
    (`shared/searchTypes.ts`). The one testable assertion of "the user confirmed" is that
    `search:replace:apply` is **not issued** until the dialog is accepted. The write-side gates are
    the ones that have an independent truth to compare against: **`planId` is one-time** (2026-10-13
    revision item 6), the **dirty revision is re-read and compared before any write**, and
    **`baselineHash` is re-checked** per file (2026-10-13 revision item 5).
    - **Why not a renderer-issued token:** renderer and main process are one trust domain, so the
      main process holds no independent value to check it against. "Token does not match the plan →
      refuse" can only degrade to a presence check (a non-empty string) — a gate that looks like
      enforcement and stops nothing, which is worse than no field because the contract then _claims_
      enforcement it does not have.
    - **Why not a main-process-issued token:** issued with the plan, holding the token is equivalent
      to holding the plan response, which is equivalent to holding `planId` — same issuer, same
      lifetime, same one-time use. Pure duplication.
    - **Why the promise itself is the problem:** "the confirmation gate is enforced by the main
      process, not by the renderer's good behaviour" names a check point that does not exist.
      Freezing it into the contract sends the implementer looking for it; the only thing they can
      build is the presence check above.
    - **Rejected alternatives (both):** `confirmationToken: string` signed by the renderer after the
      dialog, and `confirmationToken: string` signed by the main process at plan time.
    - **No contract delta:** ruling 29's frozen-contract process does not fire here —
      `shared/searchTypes.ts` needs no edit. The field has never existed in `electron/main` or in
      `shared/searchTypes.ts` (verified: zero occurrences), so recording its _absence_ is what stops
      doc↔code drift — the drift it had already started, in the direction of adding a dead field.
