import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { useUIStore } from '../../store/ui'
import { useQuickOpen } from '../../hooks/useSearch'
import { useT } from '../../i18n'
import { InputContextMenu } from '../ui/input-context-menu'
import { SearchResultList } from './SearchResults'
import { hasModalSurface } from '../../lib/shortcut-scope'

export function CommandPalette(): React.ReactElement | null {
  // Field-scoped selectors: an identity selector re-renders on every keystroke (ADR-0033).
  const searchOpen = useUIStore((s) => s.searchOpen)
  const searchQuery = useUIStore((s) => s.searchQuery)
  // Actions are stable references created once by the store initializer, so reading them via
  // getState() avoids an unnecessary subscription (Vercel rerender-defer-reads).
  const { setSearchOpen, setSearchQuery, selectDocument, setFileDetailsId } = useUIStore.getState()
  const { data, isFetching } = useQuickOpen()
  // Memoised: a fresh `[]` on every render would make the effect below re-run (and reset the
  // highlighted row) even when the results have not changed.
  const results = useMemo(() => data?.results ?? [], [data])
  const { t } = useT()
  const inputRef = useRef<HTMLInputElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)

  useEffect(() => {
    if (searchOpen) {
      const id = setTimeout(() => {
        inputRef.current?.focus()
        setSelectedIndex(0)
      }, 50)
      return () => clearTimeout(id)
    } else {
      setSearchQuery('')
    }
  }, [searchOpen, setSearchQuery])

  useEffect(() => {
    const id = setTimeout(() => setSelectedIndex(0), 0)
    return () => clearTimeout(id)
  }, [results])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // Ctrl/Cmd+Shift+K — the Quick Open chord. It MOVED here from Ctrl/Cmd+K when ADR-0032 gave
      // ⌘K to the editor's Link action (the mainstream Markdown-editor binding).
      //
      // CAPTURE phase, and it stops propagation: CodeMirror's own default keymap binds ⌘⇧K to
      // `deleteLine`, and its handler sits BELOW window on the editor's DOM — a bubble-phase
      // listener runs after it, so the keystroke would delete the line AND open the palette.
      // Claiming the key in the capture phase keeps exactly one owner (the same rule the format
      // shortcuts follow in App.tsx).
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        // Same modal guard as the other window-level shortcuts (lib/shortcut-scope): never stack
        // the palette on top of an already-open dialog, and leave the key un-swallowed.
        if (hasModalSurface(document)) return
        e.preventDefault()
        e.stopPropagation()
        setSearchOpen(true)
        return
      }
      if (e.key === 'Escape' && searchOpen) {
        setSearchOpen(false)
      }
    }
    // Capture phase — see the note on the ⌘⇧K branch above.
    window.addEventListener('keydown', handleKey, true)
    return () => window.removeEventListener('keydown', handleKey, true)
  }, [searchOpen, setSearchOpen])

  if (!searchOpen) return null

  // Goes through the guarded entry point: picking a file here is a document switch like any other,
  // and unsaved edits must not be dropped by a palette click (ADR-0023).
  const handleSelect = (id: string) => {
    void selectDocument(id).then((switched) => {
      if (switched) setSearchOpen(false)
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && results[selectedIndex]) {
      handleSelect(results[selectedIndex].documentId)
    }
  }

  return (
    <div
      // A modal overlay that owns the keyboard while open, so window-level shortcuts stand down
      // instead of opening a find panel behind it (see lib/shortcut-scope). It is not a Radix
      // dialog, so it opts in explicitly. `data-*` is used rather than `role="dialog"` to mark it
      // without changing its accessibility semantics.
      data-modal-surface=""
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/20 backdrop-blur-sm animate-fade-in"
      onClick={() => setSearchOpen(false)}
    >
      <div
        className="w-full max-w-[560px] bg-[var(--color-surface)] rounded-xl shadow-linear-lg border border-[var(--color-border)] overflow-hidden animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center px-4 py-3 border-b border-[var(--color-border)]">
          <Search size={16} className="text-[var(--color-text-tertiary)] shrink-0 mr-2" />
          {/* Right-click edit menu : the framework ships none */}
          <InputContextMenu targetRef={inputRef}>
            <input
              ref={inputRef}
              data-testid="search-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('palette.placeholder')}
              className="flex-1 bg-transparent text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus-ring"
            />
          </InputContextMenu>
          {searchQuery && (
            <button
              type="button"
              aria-label={t('search.clear')}
              onClick={() => setSearchQuery('')}
              className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
            >
              <X size={14} />
            </button>
          )}
          <kbd className="ml-2 text-xs text-[var(--color-text-tertiary)] bg-[var(--color-surface-overlay)] px-1.5 py-0.5 rounded border border-[var(--color-border)]">
            Esc
          </kbd>
        </div>

        {/* Results: flat file rows only. No mode switch, no scope control — this surface is
            "go to file" and nothing else (ADR-0023). */}
        {isFetching && searchQuery && (
          <div className="px-4 py-3 text-sm text-[var(--color-text-tertiary)]">
            {t('palette.searching')}
          </div>
        )}
        {!isFetching && searchQuery && results.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-[var(--color-text-tertiary)]">
            {t('search.noResults')}
          </div>
        )}
        {!searchQuery && (
          <div className="px-4 py-3 text-xs text-[var(--color-text-tertiary)]">
            {t('palette.startTyping')}
          </div>
        )}
        {results.length > 0 && (
          <ul>
            <SearchResultList
              results={results}
              selectedIndex={selectedIndex}
              onSelectIndex={setSelectedIndex}
              onSelect={handleSelect}
              onShowDetails={setFileDetailsId}
            />
          </ul>
        )}
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
          {/* Say what this surface searches: every entry point must name its own scope. */}
          <span className="ml-auto text-2xs text-[var(--color-text-tertiary)]">
            {t('sidebar.goToFile')}
          </span>
        </div>
      </div>
    </div>
  )
}
