import React, { useMemo } from 'react'
import { FileText, Copy, Info, FolderOpen } from 'lucide-react'
import { cn } from '../../lib/utils'
import { hitOrderIndex, hitKey } from '../../lib/search-hits'
import { useT } from '../../i18n'
import type { SearchResult, SearchMatch } from '../../types'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '../ui/context-menu'

// The two search surfaces are SPECIALIZED (ADR-0023): Quick Open lists files (flat), the Search
// view lists body hits grouped per file. They are two components rather than one component with a
// mode flag — the old `SearchPanel` decided its shape from whether a callback prop happened to be
// passed, which is exactly the kind of implicit contract that breaks silently.
//
// What they share is the per-result context menu, defined once below.

function copyText(text: string): void {
  void window.api.clipboard.writeText(text)
}

// Escape the three HTML-significant characters. Used before wrapping a matched substring in
// <mark> so a document containing `<script>` etc. can never inject markup (the only
// dangerouslySetInnerHTML call in the app). We escape the three segments separately so the
// highlight offsets (computed on the raw excerpt) stay aligned — escaping first would change
// the string length.
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function highlightExcerptHtml(match: SearchMatch): string {
  const before = escapeHtml(match.excerpt.slice(0, match.excerptStart))
  const mid = escapeHtml(match.excerpt.slice(match.excerptStart, match.excerptEnd))
  const after = escapeHtml(match.excerpt.slice(match.excerptEnd))
  return `${before}<mark>${mid}</mark>${after}`
}

export function ResultContextMenuItems({
  result,
  onSelect,
  onShowDetails,
}: {
  result: SearchResult
  onSelect: (id: string) => void
  onShowDetails: (id: string) => void
}): React.ReactElement {
  const { t } = useT()
  return (
    <ContextMenuContent>
      <ContextMenuItem
        data-testid="palette-open-document"
        onClick={() => onSelect(result.documentId)}
      >
        <FileText size={13} /> {t('ctx.openDocument')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem data-testid="palette-copy-title" onClick={() => void copyText(result.title)}>
        <Copy size={13} /> {t('ctx.copyTitle')}
      </ContextMenuItem>
      {/* The copied path stays ABSOLUTE even though the row shows a relative one: a relative path
          is useless once pasted into a terminal or file manager. */}
      <ContextMenuItem
        data-testid="palette-copy-result-path"
        disabled={!result.filePath}
        onClick={() => void copyText(result.filePath)}
      >
        <Copy size={13} /> {t('ctx.copyResultPath')}
      </ContextMenuItem>
      <ContextMenuItem
        data-testid="palette-copy-folder-path"
        disabled={!result.filePath}
        onClick={() => void copyText(result.filePath.replace(/[/\\][^/\\]*$/, ''))}
      >
        <FolderOpen size={13} /> {t('ctx.copyFolderPath')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        data-testid="palette-details"
        onClick={() => onShowDetails(result.documentId)}
      >
        <Info size={13} /> {t('sidebar.details')}
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

interface ResultListProps {
  results: SearchResult[]
  selectedIndex: number
  onSelectIndex: (i: number) => void
  onSelect: (id: string) => void
  onShowDetails: (id: string) => void
}

/** Quick Open (Ctrl/Cmd+K): one flat row per file. No scope, no hits — paths only (D1/D11). */
export function SearchResultList({
  results,
  selectedIndex,
  onSelectIndex,
  onSelect,
  onShowDetails,
}: ResultListProps): React.ReactElement {
  return (
    <div className="py-1" data-testid="search-result-list">
      {results.map((r, i) => (
        <ContextMenu key={r.documentId}>
          <ContextMenuTrigger asChild>
            <li
              data-testid="search-result"
              className={cn(
                'flex items-start gap-3 px-4 py-2.5 cursor-pointer transition-colors',
                i === selectedIndex
                  ? 'bg-[var(--color-accent-muted)]'
                  : 'hover:bg-[var(--color-surface-overlay)]',
              )}
              onClick={() => onSelect(r.documentId)}
              onMouseEnter={() => onSelectIndex(i)}
            >
              <FileText size={14} className="mt-0.5 shrink-0 text-[var(--color-text-tertiary)]" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-[var(--color-text-primary)] truncate">
                  {r.title}
                </div>
                {/* The path relative to the workspace root tells apart documents sharing a title.
                    Hidden for memory-only drafts, which have no path yet. */}
                {r.relPath && (
                  <div
                    data-testid="search-result-path"
                    className="text-2xs text-[var(--color-text-tertiary)] truncate mt-0.5"
                  >
                    {r.relPath}
                  </div>
                )}
              </div>
            </li>
          </ContextMenuTrigger>
          <ResultContextMenuItems result={r} onSelect={onSelect} onShowDetails={onShowDetails} />
        </ContextMenu>
      ))}
    </div>
  )
}

/** Search view (Ctrl/Cmd+Shift+F): body hits grouped by file, one row per occurrence. */
export function ContentResultList({
  results,
  selectedIndex,
  onSelectIndex,
  onSelect,
  onSelectMatch,
  onShowDetails,
}: ResultListProps & {
  onSelectMatch: (id: string, start: number, end: number) => void
}): React.ReactElement {
  const { t } = useT()
  // Flat index of every rendered hit row, from the SAME helper the panel's keyboard navigation
  // uses — so the highlighted row and the parent's `selectedIndex` cannot drift.
  const hitIndex = useMemo(() => hitOrderIndex(results, 'content'), [results])
  const totalMatches = results.reduce((sum, r) => sum + r.matchCount, 0)
  const filesWithMatches = results.filter((r) => r.matches.length > 0).length

  return (
    <div data-testid="content-result-list">
      <div className="py-1">
        {results.map((r) => (
          <div key={r.documentId}>
            {/* Group header: file name + REAL hit count (`matchCount`, never `matches.length`,
                which is capped at 50 for display). */}
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div
                  data-testid="search-group"
                  className="flex items-center gap-2 px-4 py-1.5 cursor-pointer hover:bg-[var(--color-surface-overlay)]"
                  onClick={() => onSelect(r.documentId)}
                >
                  <FileText size={13} className="shrink-0 text-[var(--color-text-tertiary)]" />
                  <span className="text-sm font-medium text-[var(--color-text-primary)] truncate flex-1 min-w-0">
                    {r.title}
                  </span>
                  <span
                    data-testid="search-group-count"
                    className="text-2xs text-[var(--color-text-tertiary)] shrink-0"
                  >
                    ({r.matchCount})
                  </span>
                </div>
              </ContextMenuTrigger>
              <ResultContextMenuItems
                result={r}
                onSelect={onSelect}
                onShowDetails={onShowDetails}
              />
            </ContextMenu>
            {r.matches.map((m) => {
              /* v8 ignore next -- defensive: a rendered hit is always in the index */
              const gi = hitIndex.get(hitKey(r.documentId, m.start)) ?? 0
              return (
                <button
                  type="button"
                  key={`${r.documentId}-${m.line}-${m.start}`}
                  data-testid="search-match"
                  data-selected={gi === selectedIndex}
                  onClick={() => onSelectMatch(r.documentId, m.start, m.end)}
                  onMouseEnter={() => onSelectIndex(gi)}
                  className={cn(
                    'flex items-start gap-2 pl-9 pr-4 py-1.5 w-full text-left cursor-pointer transition-colors',
                    gi === selectedIndex
                      ? 'bg-[var(--color-accent-muted)]'
                      : 'hover:bg-[var(--color-surface-overlay)]',
                  )}
                >
                  <span className="text-2xs text-[var(--color-text-tertiary)] shrink-0 mt-0.5 w-8">
                    {m.line}
                  </span>
                  <span
                    className="text-xs text-[var(--color-text-secondary)] truncate flex-1 min-w-0 font-mono"
                    dangerouslySetInnerHTML={{ __html: highlightExcerptHtml(m) }}
                  />
                </button>
              )
            })}
          </div>
        ))}
      </div>
      {totalMatches > 0 && (
        <div
          data-testid="search-summary"
          aria-live="polite"
          className="px-4 py-2 text-2xs text-[var(--color-text-tertiary)] border-t border-[var(--color-border)]"
        >
          {t('search.matchCount', { count: totalMatches, files: filesWithMatches })}
        </div>
      )}
    </div>
  )
}
