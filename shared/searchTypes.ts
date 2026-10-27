// Search wire types shared by BOTH processes. The main process builds these in
// `electron/main/ipc/search.ts`, they travel over IPC, and the renderer consumes them. They used
// to be declared twice — once in the IPC module and once in the renderer's `types/index.ts` — with
// a "mirrors the renderer's ..." comment keeping them in sync by hand. Defined once here so the
// two sides cannot drift, the same rationale as `shared/fileUtils.ts`.
//
// The query/replace envelope below is the frozen backend contract recorded in
// `docs/adr/0023-search-scope-and-specialized-surfaces.md`. Any shape change must be mirrored here
// and in that ADR, or the renderer and the main process drift apart.

// Search mode: 'filename' matches file names / relative paths only (Quick Open); 'content' matches
// Markdown body text only (Search view). The renderer no longer exposes a mode switch — the two
// surfaces are specialized (ADR-0023) — but `mode` stays a backend parameter.
export type SearchMode = 'filename' | 'content'

// One in-document occurrence of the query, surfaced by the Search view.
// `start`/`end` are UTF-16 code-unit offsets into the *matched* document content (CodeMirror doc
// positions), so the renderer can jump the editor cursor straight to the hit. `excerpt` is the
// matched line, truncated; `excerptStart`/`excerptEnd` are the matched substring's range *within*
// that (already-truncated) excerpt, ready to wrap in `<mark>` after HTML-escaping the three
// segments. Carrying the highlight range explicitly avoids any fragile "re-find the term inside
// the excerpt" logic in the renderer.
export interface SearchMatch {
  line: number
  start: number
  end: number
  // How many lines the match spans. Always 1 outside regex mode (a literal query cannot contain a
  // newline); required for regex because `excerpt` is truncated to EXCERPT_MAX, so once a match is
  // longer than that the renderer can no longer derive its real span from the text it receives.
  lineSpan: number
  excerpt: string
  excerptStart: number
  excerptEnd: number
}

// A renderer-owned unsaved buffer that must take part in content search. The main process cannot
// discover unsaved edits itself: the store's `content` IS the on-disk bytes, so reading the file
// back and comparing would always be equal (a false negative that silently searches stale text).
// See ADR-0023. Must cover EVERY dirty document, not just the active one.
export interface DirtyDocumentSnapshot {
  documentId: string
  /** The renderer's current buffer, in full. */
  content: string
  /** Monotonic version of that buffer. */
  revision: number
}

// Discriminated so the two surfaces cannot accidentally send each other's fields.
export type SearchQueryOptions =
  | { query: string; mode: 'filename' }
  | {
      query: string
      mode: 'content'
      /** Comma-separated glob/path patterns, relative to `workspaceRoot`. */
      include?: string
      exclude?: string
      /** D16: false (default) = case-insensitive body match. */
      matchCase?: boolean
      /** D30: opt-in regexp mode. Default false = the query is ONE literal phrase (D24). */
      regexp?: boolean
      /** D34: whole-word matching on UAX #29 word boundaries (D35). Default false. */
      wholeWord?: boolean
      /** D28: required for content mode; `[]` means "no dirty documents". */
      dirtyDocumentSnapshots: DirtyDocumentSnapshot[]
      /** D28: required for content mode. */
      documentStateRevision: number
    }

export type SearchDiagnosticCode =
  | 'invalid-pattern'
  | 'path-not-found'
  | 'no-workspace-root'
  | 'drafts-excluded'
  | 'out-of-root-skipped'
  | 'match-cap'
  | 'doc-cap'
  // Both belong to the QUERY, not to the scope, and are deliberately separate codes from
  // `invalid-pattern` so the UI can say which of the two needs fixing (ADR-0023 §13.7).
  | 'invalid-regex'
  | 'regex-timeout'

export interface SearchDiagnostic {
  code: SearchDiagnosticCode
  field?: 'include' | 'exclude' | 'query'
  pattern?: string
  /** true → `results` is guaranteed empty (fail-closed, D27). */
  blocking: boolean
  message: string
}

export interface SearchResult {
  documentId: string
  title: string
  /** Path relative to `workspaceRoot`; `null` for memory-only drafts (no file yet). */
  relPath: string | null
  // Absolute on-disk path, empty for memory-only drafts. Kept because the result
  // context menu copies an ABSOLUTE path: a relative one is useless once pasted into a terminal
  // or file manager.
  filePath: string
  /** Real hit count in the document — NOT capped by MAX_MATCHES_PER_DOC. */
  matchCount: number
  /** True when `matches` was truncated to MAX_MATCHES_PER_DOC. */
  matchCapped: boolean
  /** At most MAX_MATCHES_PER_DOC entries; display only. Never used for counting. */
  matches: SearchMatch[]
}

export interface SearchQueryResponse {
  results: SearchResult[]
  diagnostics: SearchDiagnostic[]
  appliedScope: { root: string | null; include: string[]; exclude: string[] }
  /** The candidate DOCUMENT set was capped at MAX_RESULT_DOCS (moved up from SearchResult). */
  truncated: boolean
}

// ─── Cross-file replace (ADR-0023) ──────────────────────────────────────────

// Zero in on one document, or one specific occurrence inside it. `matchStartUtf16` is the raw
// UTF-16 start offset of the occurrence (never a display-capped `matchIndex`).
export type ReplaceTarget = { documentId: string } | { documentId: string; matchStartUtf16: number }

export interface ReplacePlanOptions {
  query: string
  replaceText: string
  include?: string
  exclude?: string
  matchCase?: boolean
  /** Must travel with the plan: it changes what counts as a hit, so a plan made without it is
   *  not the plan the user confirmed (ADR-0023 §13.8). */
  regexp?: boolean
  /** See `regexp`: same reasoning, whole-word is part of the match semantics. */
  wholeWord?: boolean
  target?: ReplaceTarget
  /** D28: every dirty document, required. */
  unsavedDocumentIds: string[]
  /** D28: required. */
  documentStateRevision: number
  /** D29: identifies the running plan so it can be cancelled through a real IPC. */
  cancelToken: string
}

export type ReplaceSkipReason =
  | 'memory-only'
  | 'unsaved'
  | 'missing-file'
  | 'out-of-root'
  | 'unreadable'
  | 'no-hit'
  | 'external-change'

export interface ReplacePlanFile {
  documentId: string
  relPath: string
  matchCount: number
  reason?: ReplaceSkipReason
}

export interface ReplacePlanSummary {
  planId: string
  /** Files that will actually be written. */
  fileCount: number
  matchCount: number
  /** Diagnostics for skipped files — never silently dropped. */
  skipped: Array<{ documentId: string; relPath: string; reason: ReplaceSkipReason }>
}

export type ReplacePlanFailureReason =
  | 'invalid-pattern'
  | 'invalid-regex'
  | 'empty-query'
  | 'no-workspace-root'
  | 'missing-dirty-state'
  | 'aborted'
  | 'cancelled'
  | 'target-not-found'

export interface ReplacePlanAborted {
  reason: Extract<ReplacePlanFailureReason, 'aborted' | 'cancelled'>
  /** Which budget tripped. */
  limit: 'files' | 'input-bytes' | 'file-bytes' | 'output-bytes' | 'count'
  /** The offending files, named so the user can narrow the scope (D18). */
  offending: string[]
  /** Total number of offenders when `offending` was truncated. */
  offendingTotal: number
}

export type ReplacePlanOutcome =
  | { ok: true; plan: ReplacePlanSummary }
  | {
      ok: false
      reason: ReplacePlanFailureReason
      diagnostic?: SearchDiagnostic
      aborted?: ReplacePlanAborted
    }

export interface ReplaceApplyOptions {
  planId: string
  /** Re-taken immediately before apply. */
  unsavedDocumentIds: string[]
  documentStateRevision: number
}

export type ReplaceFileStatus = 'ok' | 'skipped' | 'conflict' | 'failed'

export interface ReplaceFileOutcome {
  documentId: string
  relPath: string
  status: ReplaceFileStatus
  replaced: number
  reason?: ReplaceSkipReason | 'stale-plan' | 'write-error' | 'unencodable'
}

export type ReplaceApplyOutcome =
  | { ok: true; replaced: number; files: ReplaceFileOutcome[] }
  | { ok: false; reason: 'stale-plan' | 'revision-mismatch' | 'workspace-changed'; files: [] }

export interface ReplaceUndoOutcome {
  ok: boolean
  restored: number
  skipped: number
  reason?: 'no-transaction' | 'workspace-changed'
}

// Progress payload sent over `search:replace:progress` (D29). Defined once here so the main process
// emit and the renderer's `onReplaceProgress` callback cannot drift — the same single-source
// rationale as the rest of this file. (The service's own `ReplaceProgressCallback` is the internal
// main-process callback type and is NOT this payload.)
export interface ReplaceProgressPayload {
  cancelToken: string
  done: number
  total: number
}
