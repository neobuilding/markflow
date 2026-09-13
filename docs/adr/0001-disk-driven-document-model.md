# ADR-0001: Disk-driven document model (remove the database layer)

- **Status:** Accepted
- **Decided:** 2026-08-24
- **Implemented:** 2026-08-28 (verified: 84 files / 951 unit cases pass, all `electron/main/model/**` at 100%)

## Context

MarkFlow originally kept documents in an in-process SQLite database created with
`new DatabaseConstructor(':memory:')`, i.e. an in-memory store that is wiped on process exit. It provided
three things the app actually used: a documents list (`id/title/folder_path/file_path/content/word_count/
is_archived/encoding/created_at/updated_at`), FTS5 full-text search, and an `is_archived` flag.

Two facts made this worth changing:

1. The "database" never persisted anything — it was a process-local cache, not a persistence layer.
   Removing it loses zero cross-session data.
2. VS Code-style file lists come from disk + in-memory drafts, not from a DB. The DB was an extra layer
   between the filesystem and the UI, and it pulled in a native dependency (`better-sqlite3`) that forced a
   C++ toolchain at install time.

## Decision

Remove the SQLite layer entirely and adopt a **disk-driven document model**:

- The main-process source of truth is an in-memory `documentStore` (`Map`) in
  `electron/main/model/documentStore.ts`.
- Full-text search uses **minisearch** (replacing FTS5), rebuilt per query in `electron/main/ipc/search.ts`.
- Recursive **chokidar** folder watching (`electron/main/model/folderWatcher.ts`) syncs disk changes into
  the store and feeds the sidebar, replacing the prior per-file `fs.watch` approach.
- Markdown files are written to disk (dual-write); there is no separate index file.
- The **`is_archived`** archive feature is removed.
- New documents are in-memory drafts until the first explicit save.

## Consequences

- **Positive:** no native toolchain required (`npm install` works without a C++ compiler); disk is the
  source of truth; simpler build and dependency surface.
- **Positive:** the watcher can drive the list directly, removing the "DB vs disk" seam.
- **Negative / trade-off:** the search index is rebuilt on each query rather than maintained incrementally
  (acceptable at document scale; `content` is the bottleneck, not `title`/`folderPath`).
- **Negative / trade-off:** correctness now depends on the watcher + import path; external `rename` is
  currently modeled as `unlink` + `add` (new id), so an in-progress edit whose file is renamed externally
  loses its id. Recorded as a known gap, not a regression.
