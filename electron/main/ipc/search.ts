import type { IpcMain } from 'electron'
import { getAllDocuments, type Document } from '../model/documentStore'
import { hasGlobMeta, globMatch } from './glob'
import { buildScope, inScope, relToRoot, scopeDiagnostics } from '../lib/scope-filter'
import { createScanner, type MatchOptions, type ScanResult } from '../lib/content-match'
import { getWorkspaceRoot } from '../model/workspaceRoot'
import { nodeDiskIO, type DiskIO } from '../lib/disk-io'
import { scanRegexBatch, REGEX_SCAN_TIMEOUT_MS } from '../service/regex-runner'
import { relativePath } from '../../../shared/fileUtils'
import type {
  SearchDiagnostic,
  SearchQueryOptions,
  SearchQueryResponse,
  SearchResult,
} from '../../../shared/searchTypes'

// Display caps. They bound what the PANEL shows and nothing else — in particular they must never
// take part in a replace computation, which is why the replace service carries its own, unrelated
// safety budget (ADR-0023).
export const MAX_MATCHES_PER_DOC = 50
export const MAX_RESULT_DOCS = 200

interface Scored {
  result: SearchResult
  rel: string | null
}

// Deterministic ordering, and the reason it must be deterministic: the frozen contract dropped
// `score`/`updatedAt`, and literal phrase matching has no relevance score to sort by. Sorting by
// the root-relative path gives the same order on Windows and Linux, which is what
// `docs/agents/testing.md` requires. Drafts (no path) sort last, by title.
function compare(a: Scored, b: Scored): number {
  if (a.rel === null && b.rel === null) return a.result.title.localeCompare(b.result.title)
  if (a.rel === null) return 1
  if (b.rel === null) return -1
  return a.rel.localeCompare(b.rel)
}

function emptyResponse(
  diagnostics: SearchDiagnostic[] = [],
  root: string | null = null,
): SearchQueryResponse {
  return {
    results: [],
    diagnostics,
    appliedScope: { root, include: [], exclude: [] },
    truncated: false,
  }
}

/**
 * Quick Open (Ctrl/Cmd+K): file names and relative paths only, no scope concept (D11).
 * Glob support is the ADR-0013 #5 behaviour and is deliberately unchanged (D9).
 */
function filenameSearch(docs: Document[], query: string, root: string | null): SearchResult[] {
  const useGlob = hasGlobMeta(query)
  const lower = query.toLowerCase()
  const matched = docs.filter((d) => {
    const rel = relativePath(d.filePath, root)
    if (useGlob) return globMatch(rel, query)
    return d.title.toLowerCase().includes(lower) || rel.toLowerCase().includes(lower)
  })
  return matched
    .map((d) => ({
      documentId: d.id,
      title: d.title,
      relPath: relToRoot(d.filePath, root),
      filePath: d.filePath,
      matchCount: 0,
      matchCapped: false,
      matches: [],
    }))
    .sort((a, b) => a.title.localeCompare(b.title))
}

interface Candidate {
  doc: Document
  rel: string | null
  content: string
}

// Everything up to (but not including) matching a body: scope, drafts, out-of-root documents and
// the unsaved-buffer override. Split out because regex mode needs the candidate list BEFORE it can
// scan — the scan happens in a Worker and is handed back as a completed result per document
// (ADR-0023 D37), so the two steps cannot be one loop any more.
function collectCandidates(
  docs: Document[],
  dirty: Map<string, string>,
  root: string | null,
  scope: ReturnType<typeof buildScope>['scope'],
): { candidates: Candidate[]; drafts: number; outOfRoot: number } {
  const candidates: Candidate[] = []
  let drafts = 0
  let outOfRoot = 0

  for (const d of docs) {
    const rel = d.memoryOnly ? null : relToRoot(d.filePath, root)
    // A document with a file that somehow sits outside the single root has no `rel` to match
    // (D20); it cannot be scoped, so it is reported rather than silently included.
    if (!d.memoryOnly && rel === null && d.filePath) {
      outOfRoot += 1
      continue
    }
    if (!inScope(rel, scope)) {
      if (rel === null) drafts += 1
      continue
    }
    // Unsaved buffers are searched from the renderer's snapshot: the store's `content` IS the
    // bytes last read from disk, so without this the user would search stale text (ADR-0023).
    candidates.push({ doc: d, rel, content: dirty.get(d.id) ?? d.content })
  }

  return { candidates, drafts, outOfRoot }
}

function buildResults(
  candidates: Candidate[],
  scanOf: (c: Candidate, index: number) => ScanResult,
): { results: SearchResult[]; truncated: boolean; matchCapped: boolean } {
  let matchCapped = false
  const scored: Scored[] = []

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]
    const scan = scanOf(c, i)
    // D12: Search view results are decided by real body hits ONLY. Title/path hits no longer
    // produce an empty result group, and no longer inflate the replace count.
    if (scan.total === 0) continue
    if (scan.capped) matchCapped = true
    scored.push({
      rel: c.rel,
      result: {
        documentId: c.doc.id,
        title: c.doc.title,
        relPath: c.rel,
        filePath: c.doc.filePath,
        matchCount: scan.total,
        matchCapped: scan.capped,
        matches: scan.matches,
      },
    })
  }

  scored.sort(compare)
  const truncated = scored.length > MAX_RESULT_DOCS
  return {
    results: (truncated ? scored.slice(0, MAX_RESULT_DOCS) : scored).map((s) => s.result),
    truncated,
    matchCapped,
  }
}

// Everything a content query needs before a single body is matched. Both entry points
// (`runSearchQuery`, `handleSearchQuery`) go through it so the early exits and the diagnostic
// assembly cannot drift apart.
type Prepared =
  | { kind: 'done'; response: SearchQueryResponse }
  | {
      kind: 'content'
      root: string | null
      q: string
      opts: MatchOptions
      compiled: Extract<ReturnType<typeof createScanner>, { ok: true }>
      collected: ReturnType<typeof collectCandidates>
      scope: ReturnType<typeof buildScope>['scope']
    }

function prepareSearchQuery(params: SearchQueryOptions, io: DiskIO): Prepared {
  const root = getWorkspaceRoot()
  const q = (params?.query ?? '').trim()
  if (!q) return { kind: 'done', response: emptyResponse([], root) }
  const docs = getAllDocuments()
  if (docs.length === 0) return { kind: 'done', response: emptyResponse([], root) }

  if (params.mode === 'filename') {
    const results = filenameSearch(docs, q, root)
    const truncated = results.length > MAX_RESULT_DOCS
    const diagnostics: SearchDiagnostic[] = truncated
      ? [
          {
            code: 'doc-cap',
            blocking: false,
            message: `showing the first ${MAX_RESULT_DOCS} files`,
          },
        ]
      : []
    return {
      kind: 'done',
      response: {
        results: truncated ? results.slice(0, MAX_RESULT_DOCS) : results,
        diagnostics,
        appliedScope: { root, include: [], exclude: [] },
        truncated,
      },
    }
  }

  // Content mode. The dirty-state fields are part of the frozen contract and are REQUIRED: the
  // main process cannot discover unsaved edits itself, so a caller that omits them would silently
  // search stale on-disk text. That is a programming error, not a user error — fail loudly.
  const snapshots = params.dirtyDocumentSnapshots
  const revision = params.documentStateRevision
  if (!Array.isArray(snapshots) || typeof revision !== 'number') {
    throw new TypeError(
      'search:query content mode requires dirtyDocumentSnapshots and documentStateRevision',
    )
  }
  const dirty = new Map<string, string>()
  for (const s of snapshots) {
    if (s && typeof s.documentId === 'string' && typeof s.content === 'string') {
      dirty.set(s.documentId, s.content)
    }
  }

  // A multi-line query is not supported in literal mode (ADR-0023). The renderer blocks it before
  // the IPC; here it simply matches nothing a single line could contain. (Regex mode reaches
  // newlines through the `\n` escape instead — D32 — which contains no actual newline character.)
  if (q.includes('\n') || q.includes('\r')) {
    return { kind: 'done', response: emptyResponse([], root) }
  }

  const built = buildScope(params.include, params.exclude, root, io)
  if (built.blocking) {
    // A blocking scope never reaches `applyScope` with patterns: both the invalid-pattern and
    // path-not-found paths return empty include/exclude, so there is nothing to echo here.
    return {
      kind: 'done',
      response: {
        results: [],
        diagnostics: built.diagnostics,
        appliedScope: { root, include: [], exclude: [] },
        truncated: false,
      },
    }
  }

  const collected = collectCandidates(docs, dirty, root, built.scope)

  const opts: MatchOptions = {
    matchCase: params.matchCase === true,
    regexp: params.regexp === true,
    wholeWord: params.wholeWord === true,
  }
  const compiled = createScanner(q, opts)
  if (!compiled.ok) {
    // D33: a regex that does not compile is a BLOCKING failure, not a hint. Degrading to a
    // literal search would silently match something else entirely, which is the same class of
    // bug as silently widening a scope (D27).
    return {
      kind: 'done',
      response: {
        results: [],
        diagnostics: [
          { code: 'invalid-regex', field: 'query', blocking: true, message: compiled.message },
        ],
        appliedScope: { root, include: [], exclude: [] },
        truncated: false,
      },
    }
  }

  return { kind: 'content', root, q, opts, compiled, collected, scope: built.scope }
}

function finishSearchQuery(
  prepared: Extract<Prepared, { kind: 'content' }>,
  search: ReturnType<typeof buildResults>,
): SearchQueryResponse {
  const diagnostics: SearchDiagnostic[] = []
  if (search.truncated) {
    diagnostics.push({
      code: 'doc-cap',
      blocking: false,
      message: `showing the first ${MAX_RESULT_DOCS} files`,
    })
  }
  if (search.matchCapped) {
    diagnostics.push({
      code: 'match-cap',
      blocking: false,
      message: `showing the first ${MAX_MATCHES_PER_DOC} hits per file`,
    })
  }
  diagnostics.push(
    ...scopeDiagnostics(prepared.scope, prepared.collected.drafts, prepared.collected.outOfRoot),
  )

  return {
    results: search.results,
    diagnostics,
    appliedScope: {
      root: prepared.root,
      include: prepared.scope.include.map((p) => p.raw),
      exclude: prepared.scope.exclude.map((p) => p.raw),
    },
    truncated: search.truncated,
  }
}

/**
 * Synchronous entry point. Used by the unit tests and as the fallback when the regex Worker cannot
 * be started — in regex mode it runs the pattern on this thread, which is exactly what D37 exists
 * to avoid, so production traffic goes through `handleSearchQuery` instead.
 */
export function runSearchQuery(params: SearchQueryOptions, io: DiskIO): SearchQueryResponse {
  const prepared = prepareSearchQuery(params, io)
  if (prepared.kind === 'done') return prepared.response
  const search = buildResults(prepared.collected.candidates, (c) =>
    prepared.compiled.factory.scan(c.content, MAX_MATCHES_PER_DOC),
  )
  return finishSearchQuery(prepared, search)
}

/**
 * The `search:query` handler. Async for one reason only: in regex mode the scan is handed to a
 * Worker thread so a backtracking pattern can be terminated instead of freezing the app (D37).
 * Literal mode — the default, and the only mode that runs on every keystroke — never awaits.
 */
export async function handleSearchQuery(
  params: SearchQueryOptions,
  io: DiskIO,
  runner: typeof scanRegexBatch = scanRegexBatch,
): Promise<SearchQueryResponse> {
  const prepared = prepareSearchQuery(params, io)
  if (prepared.kind === 'done') return prepared.response

  let scanOf: (c: Candidate, index: number) => ScanResult = (c) =>
    prepared.compiled.factory.scan(c.content, MAX_MATCHES_PER_DOC)

  if (prepared.opts.regexp) {
    const candidates = prepared.collected.candidates
    const outcome = await runner({
      query: prepared.q,
      opts: prepared.opts,
      max: MAX_MATCHES_PER_DOC,
      contents: candidates.map((c) => c.content),
    })
    if (!outcome.ok) {
      if (outcome.reason === 'timeout') {
        // Fail closed: the scan did not complete, so there is no trustworthy count to show. The
        // Worker was terminated, so the run really stopped (D37).
        return {
          results: [],
          diagnostics: [
            {
              code: 'regex-timeout',
              field: 'query',
              blocking: true,
              message: `the pattern took longer than ${REGEX_SCAN_TIMEOUT_MS}ms and was stopped`,
            },
          ],
          appliedScope: { root: prepared.root, include: [], exclude: [] },
          truncated: false,
        }
      }
      // 'unavailable' → no Worker to isolate in; answer the query on this thread rather than
      // refusing to search at all.
    } else {
      const byIndex = outcome.results
      scanOf = (_c, i) => byIndex[i] ?? { matches: [], total: 0, capped: false }
    }
  }

  return finishSearchQuery(prepared, buildResults(prepared.collected.candidates, scanOf))
}

export function registerSearchHandlers(ipcMainInstance: IpcMain, io: DiskIO = nodeDiskIO): void {
  ipcMainInstance.handle('search:query', (_event, params: SearchQueryOptions) =>
    handleSearchQuery(params, io),
  )
}
