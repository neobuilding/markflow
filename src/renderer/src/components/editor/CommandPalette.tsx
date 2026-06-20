import React, { useEffect, useRef, useState } from 'react'
import { Search, X, FileText, Clock } from 'lucide-react'
import { cn, formatDate } from '../../lib/utils'
import { useUIStore } from '../../store/ui'
import { useSearch } from '../../hooks/useSearch'

export function CommandPalette(): React.ReactElement | null {
  const { searchOpen, setSearchOpen, setSearchQuery, searchQuery, setActiveDocumentId } = useUIStore()
  const { data: results = [], isFetching } = useSearch()
  const inputRef = useRef<HTMLInputElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)

  useEffect(() => {
    if (searchOpen) {
      setTimeout(() => inputRef.current?.focus(), 50)
      setSelectedIndex(0)
    } else {
      setSearchQuery('')
    }
  }, [searchOpen, setSearchQuery])

  useEffect(() => {
    setSelectedIndex(0)
  }, [results])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
      if (e.key === 'Escape' && searchOpen) {
        setSearchOpen(false)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [searchOpen, setSearchOpen])

  if (!searchOpen) return null

  const handleSelect = (id: string) => {
    setActiveDocumentId(id)
    setSearchOpen(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && results[selectedIndex]) {
      handleSelect(results[selectedIndex].id)
    }
  }

  return (
    <div
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
          <input
            ref={inputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search documents…"
            className="flex-1 bg-transparent text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] outline-none"
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery('')} className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]">
              <X size={14} />
            </button>
          )}
          <kbd className="ml-2 text-xs text-[var(--color-text-tertiary)] bg-[var(--color-surface-overlay)] px-1.5 py-0.5 rounded border border-[var(--color-border)]">
            Esc
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-[380px] overflow-y-auto">
          {isFetching && searchQuery && (
            <div className="px-4 py-3 text-sm text-[var(--color-text-tertiary)]">Searching…</div>
          )}
          {!isFetching && searchQuery && results.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-[var(--color-text-tertiary)]">
              No results for "{searchQuery}"
            </div>
          )}
          {!searchQuery && (
            <div className="px-4 py-3 text-xs text-[var(--color-text-tertiary)]">
              Start typing to search your documents…
            </div>
          )}
          {results.length > 0 && (
            <ul className="py-1">
              {results.map((r, i) => (
                <li
                  key={r.id}
                  className={cn(
                    'flex items-start gap-3 px-4 py-2.5 cursor-pointer transition-colors',
                    i === selectedIndex
                      ? 'bg-[var(--color-accent-muted)]'
                      : 'hover:bg-[var(--color-surface-overlay)]'
                  )}
                  onClick={() => handleSelect(r.id)}
                  onMouseEnter={() => setSelectedIndex(i)}
                >
                  <FileText size={14} className="mt-0.5 shrink-0 text-[var(--color-text-tertiary)]" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-[var(--color-text-primary)] truncate">
                      {r.title}
                    </div>
                    {r.snippet && (
                      <div
                        className="text-xs text-[var(--color-text-tertiary)] truncate mt-0.5"
                        dangerouslySetInnerHTML={{ __html: r.snippet }}
                      />
                    )}
                  </div>
                  <div className="flex items-center gap-1 text-2xs text-[var(--color-text-tertiary)] shrink-0">
                    <Clock size={10} />
                    {formatDate(r.updatedAt)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 px-4 py-2 border-t border-[var(--color-border)] bg-[var(--color-bg)]">
          <div className="flex items-center gap-1 text-xs text-[var(--color-text-tertiary)]">
            <kbd className="px-1 py-0.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-overlay)] text-2xs">↑↓</kbd>
            navigate
          </div>
          <div className="flex items-center gap-1 text-xs text-[var(--color-text-tertiary)]">
            <kbd className="px-1 py-0.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-overlay)] text-2xs">↵</kbd>
            open
          </div>
        </div>
      </div>
    </div>
  )
}
