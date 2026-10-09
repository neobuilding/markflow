import React, { useMemo } from 'react'
import { FileText, Clock, Copy, Info, FolderOpen, Files } from 'lucide-react'
import { cn, formatDate, relativePath } from '../../lib/utils'
import { hitOrderIndex, hitKey } from '../../lib/search-hits'
import { useT } from '../../i18n'
import type { SearchResult, SearchMatch, SearchMode } from '../../types'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '../ui/context-menu'

interface SearchPanelProps {
  results: SearchResult[]
  isFetching: boolean
  query: string
  searchMode: SearchMode
  activeFolder: string | null
  selectedIndex: number
  onSelectIndex: (i: number) => void
  onSelect: (id: string) => void
  onModeChange: (mode: SearchMode) => void
  onShowDetails: (id: string) => void
  // Resident sidebar mode (Phase 4). When provided, content-mode results render as grouped
  // hit rows (one per in-document occurrence) and clicking a hit jumps the editor to the hit
  // offset. The modal command palette leaves this undefined and keeps the flat file list.
  onSelectMatch?: (id: string, start: number, end: number) => void
  // Scope toggle (resident mode only): widen the search from the active folder to every doc.
  scopeAll?: boolean
  onToggleScopeAll?: (all: boolean) => void
}

// Escape the three HTML-significant characters. Used before wrapping a matched substring in
// <mark> so a document containing `<script>` etc. can never inject markup (the only
// dangerouslySetInnerHTML call in the app). We escape the three segments separately so the
// highlight offsets (computed on the raw excerpt) stay aligned — escaping first would change
// the string length.
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// The per-result context menu items (open / copy title / copy paths / details). Grouped hit
// group-headers and flat file rows use the SAME items — only their trigger differs — so this is
// defined once and shared by both branches.
function ResultContextMenuItems({
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
      <ContextMenuItem data-testid="palette-open-document" onClick={() => onSelect(result.id)}>
        <FileText size={13} /> {t('ctx.openDocument')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem data-testid="palette-copy-title" onClick={() => void copyText(result.title)}>
        <Copy size={13} /> {t('ctx.copyTitle')}
      </ContextMenuItem>
      {/* The copied path stays ABSOLUTE even though the row now shows a relative one: a
          relative path is useless once pasted into a terminal or file manager. */}
      <ContextMenuItem
        data-testid="palette-copy-result-path"
        disabled={!result.filePath}
        onClick={() => void copyText(result.filePath)}
      >
        <Copy size={13} /> {t('ctx.copyResultPath')}
      </ContextMenuItem>
      <ContextMenuItem
        data-testid="palette-copy-folder-path"
        disabled={!result.folderPath}
        onClick={() => void copyText(result.folderPath)}
      >
        <FolderOpen size={13} /> {t('ctx.copyFolderPath')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem data-testid="palette-details" onClick={() => onShowDetails(result.id)}>
        <Info size={13} /> {t('sidebar.details')}
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

// Copy to the OS clipboard. Stateless, so it lives at module scope and is shared by the
// result context menu below.
function copyText(text: string): void {
  void window.api.clipboard.writeText(text)
}

// Build the marked-up excerpt: the matched range (already clamped to the truncated excerpt by
// the main process) is wrapped in <mark>; everything else is HTML-escaped.
function highlightExcerptHtml(match: SearchMatch): string {
  const before = escapeHtml(match.excerpt.slice(0, match.excerptStart))
  const mid = escapeHtml(match.excerpt.slice(match.excerptStart, match.excerptEnd))
  const after = escapeHtml(match.excerpt.slice(match.excerptEnd))
  return `${before}<mark>${mid}</mark>${after}`
}

// Shared search results surface used by both the Ctrl/Cmd+K command palette (modal) and the
// resident sidebar search panel. It renders the inline file-name / content mode segment, the
// active-folder scope label (plus an "All documents" toggle in resident mode), the result list
// (with per-row context menu: open / copy title / copy paths / details) and the keyboard-hint
// footer. The search input itself lives in the caller so each surface can place it (modal header
// vs. sidebar toolbar).
//
// In resident mode (`onSelectMatch` provided) and content search, results are grouped by file:
// each file shows a header (file name + hit count) followed by one clickable row per in-document
// occurrence, the latter highlighting the matched substring and jumping the editor on click.
export function SearchPanel({
  results,
  isFetching,
  query,
  searchMode,
  activeFolder,
  selectedIndex,
  onSelectIndex,
  onSelect,
  onModeChange,
  onShowDetails,
  onSelectMatch,
  scopeAll,
  onToggleScopeAll,
}: SearchPanelProps): React.ReactElement {
  const { t } = useT()

  const grouped = !!onSelectMatch && searchMode === 'content'

  // Global hit summary (resident content mode only).
  const totalMatches = grouped ? results.reduce((sum, r) => sum + r.matches.length, 0) : 0
  const filesWithMatches = grouped ? results.filter((r) => r.matches.length > 0).length : 0
  const truncated = results.some((r) => r.truncated)
  // `onSelectMatch` is supplied only by the resident sidebar panel (never by the Ctrl/Cmd+K
  // modal), so it also identifies the resident surface — used to keep modal-only chrome out.
  const isResident = !!onSelectMatch
  // Flat index of every rendered hit row, from the SAME helper the resident panel's keyboard
  // navigation uses — so the highlighted row and the parent's `selectedIndex` cannot drift.
  const hitIndex = useMemo(() => hitOrderIndex(results, searchMode), [results, searchMode])
  // Whether ANY row will actually render. In grouped mode a document whose matches are all
  // fuzzy/prefix (no literal term in the body) is filtered out of the list, so a non-empty
  // `results` can still produce an empty panel — that must read as "no results", not blank.
  const hasRows = grouped ? totalMatches > 0 : results.length > 0

  return (
    <div>
      {/* Search scope + mode. The resident panel (onToggleScopeAll present) gets an ICON-ONLY
          scope control and no text label: the words ("Current folder and its sub-folders" repeated
          by the toggle beside it) could not fit the narrow sidebar, so the row wrapped and CJK
          labels broke one character per line. Icons + tooltips free ~100px, which puts scope and
          mode on one comfortable row. The modal palette (no onToggleScopeAll) keeps the text
          label, since there is no toggle there to carry the meaning. `flex-wrap` remains a safety
          net so a very narrow sidebar wraps into two clean rows rather than mid-character. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-1.5 border-b border-[var(--color-border)] text-xs text-[var(--color-text-tertiary)]">
        {onToggleScopeAll ? (
          activeFolder && (
            <div className="flex items-center rounded border border-[var(--color-border)] overflow-hidden shrink-0">
              <button
                type="button"
                data-testid="search-scope-infolder"
                title={t('search.inFiles')}
                aria-label={t('search.inFiles')}
                onClick={() => onToggleScopeAll(false)}
                className={cn(
                  'px-1.5 py-0.5 transition-colors',
                  !scopeAll
                    ? 'bg-[var(--color-accent-muted)] text-accent'
                    : 'hover:text-[var(--color-text-secondary)]',
                )}
              >
                <FolderOpen size={12} />
              </button>
              <button
                type="button"
                data-testid="search-scope-all"
                title={t('search.allDocuments')}
                aria-label={t('search.allDocuments')}
                onClick={() => onToggleScopeAll(true)}
                className={cn(
                  'px-1.5 py-0.5 border-l border-[var(--color-border)] transition-colors',
                  scopeAll
                    ? 'bg-[var(--color-accent-muted)] text-accent'
                    : 'hover:text-[var(--color-text-secondary)]',
                )}
              >
                <Files size={12} />
              </button>
            </div>
          )
        ) : (
          <span data-testid="search-scope">
            {activeFolder ? t('palette.scopeFolder') : t('palette.scopeAll')}
          </span>
        )}
        <div className="ml-auto flex items-center rounded border border-[var(--color-border)] overflow-hidden shrink-0">
          <button
            type="button"
            data-testid="search-mode-filename"
            onClick={() => onModeChange('filename')}
            className={cn(
              'px-2 py-0.5 transition-colors',
              searchMode === 'filename'
                ? 'bg-[var(--color-accent-muted)] text-accent'
                : 'hover:text-[var(--color-text-secondary)]',
            )}
          >
            {t('palette.mode.filename')}
          </button>
          <button
            type="button"
            data-testid="search-mode-content"
            onClick={() => onModeChange('content')}
            className={cn(
              'px-2 py-0.5 border-l border-[var(--color-border)] transition-colors',
              searchMode === 'content'
                ? 'bg-[var(--color-accent-muted)] text-accent'
                : 'hover:text-[var(--color-text-secondary)]',
            )}
          >
            {t('palette.mode.content')}
          </button>
        </div>
      </div>

      {/* Results */}
      <div className="max-h-[380px] overflow-y-auto">
        {isFetching && query && (
          <div className="px-4 py-3 text-sm text-[var(--color-text-tertiary)]">
            {t('palette.searching')}
          </div>
        )}
        {!isFetching && query && !hasRows && (
          <div className="px-4 py-8 text-center text-sm text-[var(--color-text-tertiary)]">
            {t('search.noResults')}
          </div>
        )}
        {!query && (
          <div className="px-4 py-3 text-xs text-[var(--color-text-tertiary)]">
            {t('palette.startTyping')}
          </div>
        )}
        {/* Filename mode explains the glob syntax the user can type (plan §3.8). Resident
            surface only, so the Ctrl/Cmd+K modal keeps its current chrome. */}
        {isResident && searchMode === 'filename' && (
          <div
            data-testid="search-glob-hint"
            className="px-4 py-1.5 text-2xs text-[var(--color-text-tertiary)] border-b border-[var(--color-border)]"
          >
            {t('search.globHint')}
          </div>
        )}
        {hasRows && (
          <div className="py-1">
            {grouped
              ? results
                  .filter((r) => r.matches.length > 0)
                  .map((r) => (
                    <div key={r.id}>
                      {/* Group header: file name + hit count. Clicking it opens the document
                          (without jumping to a specific hit); the per-occurrence rows below jump. */}
                      <ContextMenu>
                        <ContextMenuTrigger asChild>
                          <div
                            data-testid="search-group"
                            className="flex items-center gap-2 px-4 py-1.5 cursor-pointer hover:bg-[var(--color-surface-overlay)]"
                            onClick={() => onSelect(r.id)}
                          >
                            <FileText
                              size={13}
                              className="shrink-0 text-[var(--color-text-tertiary)]"
                            />
                            <span className="text-sm font-medium text-[var(--color-text-primary)] truncate flex-1 min-w-0">
                              {r.title}
                            </span>
                            {/* Plan §3.8: the group header renders "file name (hit count)". */}
                            <span
                              data-testid="search-group-count"
                              className="text-2xs text-[var(--color-text-tertiary)] shrink-0"
                            >
                              ({r.matches.length})
                            </span>
                          </div>
                        </ContextMenuTrigger>
                        <ResultContextMenuItems
                          result={r}
                          onSelect={onSelect}
                          onShowDetails={onShowDetails}
                        />
                      </ContextMenu>
                      {/* Per-occurrence hit rows. */}
                      {r.matches.map((m) => {
                        // Flat index comes from the shared ordering helper, not a running
                        // counter, so it matches the resident panel's nav list by construction.
                        // The fallback is unreachable: the index is built from the same
                        // `results` these rows are rendered from, so every hit is present.
                        /* v8 ignore next -- defensive: a rendered hit is always in the index */
                        const gi = hitIndex.get(hitKey(r.id, m.start)) ?? 0
                        return (
                          <button
                            type="button"
                            key={`${r.id}-${m.line}-${m.start}`}
                            data-testid="search-match"
                            data-selected={gi === selectedIndex}
                            onClick={() => onSelectMatch?.(r.id, m.start, m.end)}
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
                  ))
              : results.map((r, i) => (
                  // Result row menu. This is the worst case for Portal bubbling: the overlay behind
                  // it closes the palette on click and the <li> itself opens the document.
                  // ContextMenuContent stops the bubble once for every item, so neither fires when a
                  // menu item is chosen.
                  <ContextMenu key={r.id}>
                    <ContextMenuTrigger asChild>
                      <li
                        data-testid="search-result"
                        className={cn(
                          'flex items-start gap-3 px-4 py-2.5 cursor-pointer transition-colors',
                          i === selectedIndex
                            ? 'bg-[var(--color-accent-muted)]'
                            : 'hover:bg-[var(--color-surface-overlay)]',
                        )}
                        onClick={() => onSelect(r.id)}
                        onMouseEnter={() => onSelectIndex(i)}
                      >
                        <FileText
                          size={14}
                          className="mt-0.5 shrink-0 text-[var(--color-text-tertiary)]"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-[var(--color-text-primary)] truncate">
                            {r.title}
                          </div>
                          {/* Path relative to the active folder (ADR-0013 §4): short enough to
                              scan, and still tells apart documents sharing a title. Falls back to
                              the stored path when no folder is open (no root to be relative to).
                              Hidden for memory-only drafts. The menu below still COPIES the
                              absolute path, which is what you can paste elsewhere. */}
                          {r.filePath && (
                            <div
                              data-testid="search-result-path"
                              className="text-2xs text-[var(--color-text-tertiary)] truncate mt-0.5"
                            >
                              {relativePath(r.filePath, activeFolder)}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1 text-2xs text-[var(--color-text-tertiary)] shrink-0">
                          <Clock size={10} />
                          {formatDate(r.updatedAt)}
                        </div>
                      </li>
                    </ContextMenuTrigger>
                    <ResultContextMenuItems
                      result={r}
                      onSelect={onSelect}
                      onShowDetails={onShowDetails}
                    />
                  </ContextMenu>
                ))}
          </div>
        )}
        {/* Global hit summary (resident content mode). */}
        {grouped && totalMatches > 0 && (
          <div
            data-testid="search-summary"
            aria-live="polite"
            className="px-4 py-2 text-2xs text-[var(--color-text-tertiary)] border-t border-[var(--color-border)]"
          >
            {t('search.matchCount', { count: totalMatches, files: filesWithMatches })}
            {truncated && (
              <span data-testid="search-truncated" className="ml-1">
                {t('search.showingFirst', { n: results.length })}
              </span>
            )}
          </div>
        )}
        {/* Filename-mode truncation note (plan §5.9 / G8): the grouped summary above is content-mode
            only, so filename mode surfaces its own. Same `search.showingFirst` copy. `truncated` being
            true already implies a non-empty result set, so there is no separate empty-set branch. */}
        {!grouped && truncated && (
          <div
            data-testid="search-truncated"
            className="px-4 py-2 text-2xs text-[var(--color-text-tertiary)] border-t border-[var(--color-border)]"
          >
            {t('search.showingFirst', { n: results.length })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-3 px-4 py-2 border-t border-[var(--color-border)] bg-[var(--color-bg)]">
        <div className="flex items-center gap-1 text-xs text-[var(--color-text-tertiary)]">
          <kbd className="px-1 py-0.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-overlay)] text-2xs">
            ↑↓
          </kbd>
          {t('palette.navigate')}
        </div>
        <div className="flex items-center gap-1 text-xs text-[var(--color-text-tertiary)]">
          <kbd className="px-1 py-0.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-overlay)] text-2xs">
            ↵
          </kbd>
          {t('palette.open')}
        </div>
      </div>
    </div>
  )
}
