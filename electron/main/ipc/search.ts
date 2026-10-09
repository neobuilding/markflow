import type { IpcMain } from 'electron'
import MiniSearch from 'minisearch'
import { getAllDocuments, listDocuments, type Document } from '../model/documentStore'
import { hasGlobMeta, globMatch } from './glob'
import { relativePath } from '../../../shared/fileUtils'

// The search wire types (SearchMode / SearchMatch / SearchResult) are shared with the renderer and
// live in `shared/searchTypes.ts` — they used to be declared twice, here and in the renderer's
// `types/index.ts`, kept in sync only by a "mirrors ..." comment.
import type { SearchMode, SearchMatch, SearchResult } from '../../../shared/searchTypes'

// Bounds for the resident-panel hit context (Q21 / §3.8): cap per-document occurrences and the
// number of candidate documents so a broad query over a large library never scans/returns
// unbounded data.
const MAX_MATCHES_PER_DOC = 50
const MAX_RESULT_DOCS = 200
const EXCERPT_MAX = 120

// ─── Search index (minisearch) ───────────────────────────────────────────────
// minisearch is a pure-JS inverted index. We rebuild it from the in-memory store
// on each query; the document set is small (hundreds to low thousands) so a full
// rebuild per query is negligible and avoids keeping the index in sync with mutations.
//
// CJK note: minisearch's default tokenizer splits on whitespace/punctuation, which
// returns 0 matches for Chinese text. We supply a custom tokenizer that uses
// Intl.Segmenter (granularity 'word') for CJK and lower-cases ASCII, so both ASCII
// space-separated words and CJK word sequences are indexed correctly.

// Minimal structural type for Intl.Segmenter (the TS lib may not ship the type on
// every target; we only rely on `segment()` returning word-like segments).
interface SegmenterSegment {
  segment: string
  isWordLike?: boolean
}
interface SegmenterLike {
  segment(input: string): Iterable<SegmenterSegment>
}
let segmenter: SegmenterLike | null = null
function getSegmenter(): SegmenterLike | null {
  const IntlAny = Intl as unknown as {
    Segmenter?: new (locale: string, opts: { granularity: string }) => SegmenterLike
  }
  if (typeof IntlAny.Segmenter === 'undefined') return null
  if (!segmenter) {
    segmenter = new IntlAny.Segmenter('zh', { granularity: 'word' })
  }
  return segmenter
}

function tokenize(text: string): string[] {
  const seg = getSegmenter()
  if (!seg) {
    // Fallback for runtimes without Intl.Segmenter: split on whitespace/punctuation.
    return text
      .toLowerCase()
      .split(/[\s\p{P}]+/u)
      .filter((t) => t.length > 0)
  }
  const out: string[] = []
  for (const { segment, isWordLike } of seg.segment(text)) {
    if (isWordLike) out.push(segment.toLowerCase())
  }
  return out
}

function buildIndex(
  docs: Array<{ id: string; title: string; folderPath: string; content: string }>,
  fields: string[],
) {
  const mini = new MiniSearch<{
    id: string
    title: string
    folderPath: string
    content: string
  }>({
    // `folderPath` is indexed in 'content' mode (Q2): searching a path fragment
    // (e.g. a subfolder name or a file extension) surfaces matching documents, enabling
    // Ctrl+P-style file/path lookup. In 'filename' mode only `title` is indexed so the
    // query is matched against file names only.
    fields,
    storeFields: ['title', 'folderPath'],
    tokenize,
    processTerm: (t) => t.toLowerCase(),
  })
  mini.addAll(
    docs.map((d) => ({
      id: d.id,
      title: d.title,
      folderPath: d.folderPath,
      content: d.content,
    })),
  )
  return mini
}

export function registerSearchHandlers(ipcMainInstance: IpcMain): void {
  ipcMainInstance.handle(
    'search:query',
    (_event, params: { query?: string; scopeFolder?: string | null; mode?: SearchMode }) => {
      const q = (params?.query ?? '').trim()
      if (!q) return []
      // Scope: when a folder is supplied, restrict to its markdown documents (the folder
      // itself plus every descendant sub-folder) via listDocuments' isInFolder filter.
      // A null/empty scope searches the whole workspace, which keeps the global Ctrl+K
      // behaviour intact when no folder is active.
      const scoped = params?.scopeFolder ? listDocuments(params.scopeFolder) : getAllDocuments()
      if (!scoped.length) return []
      // Mode: 'filename' matches file names (glob over the path relative to the active
      // folder); 'content' (default) is full-text across title + body + folder path.
      const mode: SearchMode = params?.mode === 'filename' ? 'filename' : 'content'
      return mode === 'filename'
        ? filenameSearch(scoped, q, params?.scopeFolder)
        : contentSearch(scoped, q)
    },
  )
}

// Split a content-mode query into the literal terms we scan each line for. Lower-cased and
// whitespace-stripped, so a query like "Machine Learning" yields ['machine', 'learning']. This
// is a deliberate, documented simplification of minisearch's fuzzy/prefix matching (Q21): a
// fuzzy hit whose word does not appear as a literal substring in the body is still listed as a
// result but contributes no `matches` row — an acceptable degradation, not a correctness bug.
function splitTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)
}

// Collect bounded in-document occurrences of the query terms. Line offsets are computed against
// the raw content (so they align with CodeMirror doc positions even on CRLF files — we locate
// line boundaries via `indexOf('\n')` rather than `split`, which would drop the `\r`). Within a
// line we find every case-insensitive substring hit for every term, then drop overlaps so an
// embedded term (e.g. 'he' inside 'the') does not double-count. Capped at `maxPerDoc` occurrences
// (per-document bound); the cross-document cap (MAX_RESULT_DOCS) is applied by the caller.
export function extractMatches(content: string, terms: string[], maxPerDoc: number): SearchMatch[] {
  if (!content || terms.length === 0) return []
  const matches: SearchMatch[] = []
  let lineStart = 0
  let lineNo = 1
  while (lineStart <= content.length) {
    const nl = content.indexOf('\n', lineStart)
    const lineEnd = nl === -1 ? content.length : nl
    const lineText = content.slice(lineStart, lineEnd)
    const hits: Array<{ from: number; to: number }> = []
    const lower = lineText.toLowerCase()
    for (const term of terms) {
      let idx = lower.indexOf(term)
      while (idx !== -1) {
        hits.push({ from: lineStart + idx, to: lineStart + idx + term.length })
        idx = lower.indexOf(term, idx + term.length)
      }
    }
    // Sort by start, then keep only non-overlapping hits (a later hit that starts at or after
    // the previous hit's end wins; an embedded hit is dropped).
    hits.sort((a, b) => a.from - b.from)
    let prevEnd = -1
    for (const h of hits) {
      if (h.from >= prevEnd) {
        const excerpt = lineText.slice(0, EXCERPT_MAX)
        const relFrom = h.from - lineStart
        const relTo = h.to - lineStart
        let excerptStart = relFrom
        let excerptEnd = relTo
        if (relFrom >= EXCERPT_MAX) {
          excerptStart = EXCERPT_MAX
          excerptEnd = EXCERPT_MAX
        } else if (relTo > EXCERPT_MAX) {
          excerptEnd = EXCERPT_MAX
        }
        matches.push({
          line: lineNo,
          start: h.from,
          end: h.to,
          excerpt,
          excerptStart,
          excerptEnd,
        })
        prevEnd = h.to
        if (matches.length >= maxPerDoc) return matches
      }
    }
    if (nl === -1) break
    lineStart = nl + 1
    lineNo += 1
  }
  return matches
}

// File-name search: when the query contains glob metacharacters, match each document's path
// (relative to the active folder) with picomatch — the same matcher VS Code's file search
// uses, so `*.md`, `src/**/*.ts`, `note[1-3].md` all work. Otherwise fall back to a
// case-insensitive substring match over the title and relative path so plain queries still
// surface files. No body snippet is returned: filename mode is about paths, not content, and
// it carries no `matches` (hits are shown as flat file rows, not grouped occurrences).
function filenameSearch(
  docs: Document[],
  query: string,
  scopeFolder?: string | null,
): SearchResult[] {
  const useGlob = hasGlobMeta(query)
  const lower = query.toLowerCase()
  const matched = docs.filter((d) => {
    const rel = relativePath(d.filePath, scopeFolder)
    if (useGlob) return globMatch(rel, query)
    return d.title.toLowerCase().includes(lower) || rel.toLowerCase().includes(lower)
  })
  // Bounds the result set so a broad glob (`*`, `**`) over a large library never returns an
  // unbounded list — matches the content-mode cap (§3.8 / Q26(e)).
  const capped = matched.length > MAX_RESULT_DOCS
  const top = capped ? matched.slice(0, MAX_RESULT_DOCS) : matched
  return top
    .map((d) => ({
      id: d.id,
      title: d.title,
      folderPath: d.folderPath,
      filePath: d.filePath,
      score: 0,
      updatedAt: d.updatedAt,
      matches: [],
      truncated: capped,
    }))
    .sort((a, b) => a.title.localeCompare(b.title))
}

// Full-text search across title + body + folder path. Per plan §3.5 the body snippet is no
// longer returned (to avoid leaking large spans of document text into the UI); the sidebar
// renders the matched document by title and on-disk path instead. For the resident panel
// (Phase 4) each hit document also carries bounded `matches`: the in-document occurrences of
// the query terms, capped per document (MAX_MATCHES_PER_DOC) and across documents
// (MAX_RESULT_DOCS). Docs whose only match was fuzzy/prefix (no literal term in the body) get an
// empty `matches` array and are simply not expanded into a group.
function contentSearch(docs: Document[], query: string): SearchResult[] {
  const byId = new Map(docs.map((d) => [d.id, d]))
  const terms = splitTerms(query)
  const mini = buildIndex(
    docs.map((d) => ({ id: d.id, title: d.title, folderPath: d.folderPath, content: d.content })),
    ['title', 'content', 'folderPath'],
  )
  const results = mini.search(query, {
    fuzzy: 0.2,
    prefix: true,
    boost: { title: 2, folderPath: 1.5 },
  })
  const capped = results.length > MAX_RESULT_DOCS
  const top = capped ? results.slice(0, MAX_RESULT_DOCS) : results
  return top
    .map((r) => {
      const doc = byId.get(r.id as string)
      const matches = doc ? extractMatches(doc.content, terms, MAX_MATCHES_PER_DOC) : []
      return {
        id: r.id as string,
        title: (r.title as string) ?? '',
        folderPath: (r.folderPath as string) ?? '',
        filePath: doc?.filePath ?? '',
        score: r.score,
        updatedAt: doc?.updatedAt ?? 0,
        matches,
        truncated: capped,
      }
    })
    .sort(
      (a, b) =>
        // Plan §3.8 / Q12: minisearch relevance first, title-lexicographic as the tiebreak
        // (same rule filename mode already applies).
        b.score - a.score || a.title.localeCompare(b.title),
    )
}
