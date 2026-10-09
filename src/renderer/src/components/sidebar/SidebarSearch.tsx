import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, X, ChevronDown, ChevronRight } from 'lucide-react'
import { useUIStore } from '../../store/ui'
import { useT } from '../../i18n'
import { InputContextMenu } from '../ui/input-context-menu'
import { SearchPanel } from '../editor/SearchPanel'
import type { SearchResult, SearchMode } from '../../types'
import { flattenHitOrder, type HitItem } from '../../lib/search-hits'

// Resident "search in files" panel pinned above the document tree (Phase 4). Unlike the
// Ctrl/Cmd+K command palette — which is a transient quick-jump modal — this one stays open and
// is the browse/iterate surface: it groups content-mode hits by file and jumps the editor to the
// clicked occurrence. Input is debounced (~200ms) before hitting the search IPC so a broad query
// never scans the whole library on every keystroke (VS Code parity). The collapse state is
// session-in-memory (never persisted), like every other UI setting.
export function SidebarSearch(): React.ReactElement {
  const { t } = useT()
  const activeFolder = useUIStore((s) => s.activeFolder)
  const collapsed = useUIStore((s) => s.residentSearchCollapsed)
  const setCollapsed = useUIStore((s) => s.setResidentSearchCollapsed)
  const setActiveDocumentId = useUIStore((s) => s.setActiveDocumentId)
  const setFileDetailsId = useUIStore((s) => s.setFileDetailsId)
  const openDocumentWithMatch = useUIStore((s) => s.openDocumentWithMatch)

  // Local only: the resident panel's own query text, search mode, and the "All documents" scope
  // toggle. Resetting on sidebar unmount is acceptable (session UI); the collapse state lives in
  // the store so it survives a sidebar toggle.
  //
  // The mode is deliberately NOT the store's `searchMode`: that one belongs to the Ctrl/Cmd+K
  // palette, and sharing it meant either surface's toggle silently changed the other
  // (plan §3.8: the two surfaces have separate responsibilities).
  const [query, setQuery] = useState('')
  const [deferredQuery, setDeferredQuery] = useState('')
  const [searchMode, setSearchMode] = useState<SearchMode>('content')
  const [scopeAll, setScopeAll] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Debounce the query: the input updates immediately, but the IPC only fires after 200ms of
  // quiet. Clearing the text cancels the pending timer so we don't search an empty string.
  useEffect(() => {
    const id = setTimeout(() => setDeferredQuery(query), 200)
    return () => clearTimeout(id)
  }, [query])

  const scopeFolder = scopeAll || !activeFolder ? null : activeFolder
  const { data, isFetching } = useQuery({
    queryKey: ['resident-search', deferredQuery, searchMode, scopeFolder],
    queryFn: () =>
      window.api.search.query(deferredQuery, { scopeFolder, mode: searchMode }) as Promise<
        SearchResult[]
      >,
    enabled: deferredQuery.trim().length > 0,
    staleTime: 1000 * 5,
  })
  // Memoized so the identity is stable across renders when there is no data yet — an inline
  // `?? []` would hand `navItems` / the reset key a fresh array on every render.
  const results = useMemo(() => (data as SearchResult[] | undefined) ?? [], [data])

  // Flat navigation list. Shares `flattenHitOrder` with SearchPanel so the keyboard order and
  // the rendered row order can never diverge. `start`/`end` are absent for plain file rows
  // (file-name mode), present for content occurrences.
  const navItems = useMemo<HitItem[]>(
    () => flattenHitOrder(results, searchMode),
    [results, searchMode],
  )

  // G6: Ctrl/Cmd+Shift+F focuses this panel. The EditorPane window handler dispatches
  // `sidebar:focusSearch`; we expand (the collapse state lives in the store) and focus the input.
  // Same modal-guard philosophy as every other window shortcut: the key is only ours when nothing
  // else owns it, and we never steal focus from a text field (handled upstream in EditorPane).
  useEffect(() => {
    const onFocusSearch = () => {
      setCollapsed(false)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
    document.addEventListener('sidebar:focusSearch', onFocusSearch)
    return () => document.removeEventListener('sidebar:focusSearch', onFocusSearch)
  }, [setCollapsed])

  // Platform-dependent shortcut label for the hint chip (the key combo itself isn't translated).
  const isMac = useMemo(() => /Mac|iPod|iPhone|iPad/.test(navigator.userAgent), [])

  // Reset the highlighted row whenever the result set / query / mode / scope changes. Done during
  // render (React re-renders immediately without committing) instead of in an effect, which would
  // cost an extra cascading render on every keystroke.
  const resetKey = `${deferredQuery}|${searchMode}|${scopeFolder ?? ''}|${results.length}|${
    results[0]?.id ?? ''
  }`
  const [lastResetKey, setLastResetKey] = useState(resetKey)
  if (lastResetKey !== resetKey) {
    setLastResetKey(resetKey)
    setSelectedIndex(0)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, Math.max(navItems.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      const item = navItems[selectedIndex]
      if (item) {
        // Content hit: jump the editor to the occurrence. File row / group header: just open.
        if (item.start !== undefined && item.end !== undefined) {
          openDocumentWithMatch(item.id, item.start, item.end)
        } else {
          setActiveDocumentId(item.id)
        }
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setCollapsed(true)
    }
  }

  return (
    <div className="border-b border-[var(--color-border)] shrink-0">
      <button
        type="button"
        data-testid={collapsed ? 'resident-search-expand' : 'resident-search-collapse'}
        aria-label={t('sidebar.searchPanel')}
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-1.5 w-full px-3 py-1.5 text-xs text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-overlay)] transition-colors"
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <Search size={12} />
        <span>{t('sidebar.search')}</span>
      </button>
      {!collapsed && (
        <>
          <div className="px-3 pt-1.5 pb-2 border-t border-[var(--color-border)]">
            {/* A field that actually reads as a field: bordered + filled, with the magnifier and the
                clear button INSIDE it. Previously the icon, a borderless transparent <input> and the
                clear button floated loose on the panel background, so the query box was visually
                indistinguishable from static text. */}
            <div
              data-testid="resident-search-box"
              className="flex items-center gap-1.5 h-7 px-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] focus-within:border-accent transition-colors"
            >
              <Search size={13} className="text-[var(--color-text-tertiary)] shrink-0" />
              <InputContextMenu targetRef={inputRef}>
                <input
                  ref={inputRef}
                  data-testid="resident-search-input"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder={t('palette.placeholder')}
                  className="flex-1 bg-transparent text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] outline-none min-w-0"
                />
              </InputContextMenu>
              {query && (
                <button
                  type="button"
                  data-testid="resident-search-clear"
                  onClick={() => setQuery('')}
                  className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] shrink-0"
                  aria-label={t('find.close')}
                >
                  <X size={13} />
                </button>
              )}
              {/* Esc hint (plan §3.4): the key itself is universal, so only the explanation is
                  translated and exposed as a tooltip. */}
              <kbd
                data-testid="resident-search-esc"
                title={t('search.escHint')}
                className="shrink-0 px-1 py-0.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-overlay)] text-2xs text-[var(--color-text-tertiary)]"
              >
                Esc
              </kbd>
              <kbd
                data-testid="resident-search-focus"
                title={t('search.focusHint')}
                className="shrink-0 px-1 py-0.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-overlay)] text-2xs text-[var(--color-text-tertiary)]"
              >
                {isMac ? '⌘⇧F' : 'Ctrl+⇧F'}
              </kbd>
            </div>
          </div>
          <SearchPanel
            results={results}
            isFetching={isFetching}
            query={deferredQuery}
            searchMode={searchMode}
            activeFolder={activeFolder}
            selectedIndex={selectedIndex}
            onSelectIndex={setSelectedIndex}
            onSelect={setActiveDocumentId}
            onModeChange={setSearchMode}
            onShowDetails={setFileDetailsId}
            onSelectMatch={openDocumentWithMatch}
            scopeAll={scopeAll}
            onToggleScopeAll={setScopeAll}
          />
        </>
      )}
    </div>
  )
}
