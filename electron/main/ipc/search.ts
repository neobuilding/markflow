import type { IpcMain } from 'electron'
import MiniSearch from 'minisearch'
import { getAllDocuments, listDocuments } from '../model/documentStore'

// Search mode: 'filename' indexes only the document title (file name); 'content'
// indexes title + body + folder path (the original full-text behaviour).
export type SearchMode = 'filename' | 'content'

// ─── Search index (minisearch) ───────────────────────────────────────────────
// minisearch is a pure-JS inverted index. We rebuild it from the in-memory store
// on each query; the document set is small (hundreds to low thousands) so a full
// rebuild per query is negligible and avoids keeping the index in sync with mutations.
//
// CJK note: minisearch's default tokenizer splits on whitespace/punctuation, which
// returns 0 matches for Chinese text. We supply a custom tokenizer that uses
// Intl.Segmenter (granularity 'word') for CJK and lower-cases ASCII, so both
// "hello world" and "" are indexed correctly

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

// Generate an HTML snippet with the matched query terms wrapped in <mark>, mirroring
// the snippet output consumed by CommandPalette (dangerouslySetInnerHTML).
// @internal Exported only so the snippet logic (including the no-match fallback
// branch) can be unit-tested directly; production code uses it via search:query.
export function makeSnippet(content: string, terms: string[], maxLen = 120): string {
  if (!content) return ''
  const lower = content.toLowerCase()
  let hit = -1
  for (const term of terms) {
    const idx = lower.indexOf(term.toLowerCase())
    if (idx !== -1 && (hit === -1 || idx < hit)) hit = idx
  }
  let snippet: string
  if (hit === -1) {
    snippet = content.slice(0, maxLen)
  } else {
    const start = Math.max(0, hit - 40)
    const end = Math.min(content.length, hit + 80)
    snippet = (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '')
  }
  // Escape HTML, then wrap matches in <mark>.
  const escaped = snippet.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const pattern = terms
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  if (!pattern) return escaped
  return escaped.replace(new RegExp(`(${pattern})`, 'gi'), '<mark>$1</mark>')
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
      // Mode: 'filename' indexes only titles; 'content' (default) indexes title + body
      // + folder path for full-text search.
      const mode: SearchMode = params?.mode === 'filename' ? 'filename' : 'content'
      const fields = mode === 'filename' ? ['title'] : ['title', 'content', 'folderPath']
      const boost: { [fieldName: string]: number } =
        mode === 'filename' ? { title: 2 } : { title: 2, folderPath: 1.5 }
      const byId = new Map(scoped.map((d) => [d.id, d]))
      const mini = buildIndex(
        scoped.map((d) => ({
          id: d.id,
          title: d.title,
          folderPath: d.folderPath,
          content: d.content,
        })),
        fields,
      )
      const results = mini.search(q, {
        fuzzy: 0.2,
        prefix: true,
        boost,
      })
      return results.map((r) => {
        const doc = byId.get(r.id as string)
        const content = doc?.content ?? ''
        const terms = (r.terms as string[]) ?? []
        return {
          id: r.id as string,
          title: (r.title as string) ?? '',
          folderPath: (r.folderPath as string) ?? '',
          filePath: doc?.filePath ?? '',
          snippet: makeSnippet(content, terms),
          score: r.score,
          updatedAt: doc?.updatedAt ?? 0,
        }
      })
    },
  )
}
