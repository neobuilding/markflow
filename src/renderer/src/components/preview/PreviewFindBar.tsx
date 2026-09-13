import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Search, X, ChevronUp, ChevronDown } from 'lucide-react'
import { useT } from '../../i18n'

interface PreviewFindBarProps {
  // Ref to the preview CONTENT container (the rendered article subtree). The find bar
  // UI itself must live OUTSIDE this container so its own labels are never matched.
  containerRef: React.RefObject<HTMLElement | null>
}

const MARK_CLASS = 'preview-find-match'
const ACTIVE_CLASS = 'preview-find-active'

// Remove any previously-applied highlights, restoring the original text nodes.
function clearMarks(container: HTMLElement): void {
  const marks = container.querySelectorAll(`mark.${MARK_CLASS}`)
  marks.forEach((m) => {
    const parent = m.parentNode
    /* v8 ignore next -- a detached <mark> can never be queried, so parent is always set here */
    if (!parent) return
    parent.replaceChild(document.createTextNode(m.textContent as string), m)
    parent.normalize()
  })
}

// Highlight every occurrence of `q` inside `container` and return the created <mark> elements
// (in document order). Case-insensitive; covers multiple matches within a single text node.
function runSearch(container: HTMLElement, q: string): HTMLElement[] {
  clearMarks(container)
  if (!q) return []
  const lower = q.toLowerCase()
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      // nodeValue of a SHOW_TEXT node is always a string.
      const text = node.nodeValue as string
      if (text.trim() === '') return NodeFilter.FILTER_REJECT
      const parent = node.parentNode as HTMLElement | null
      if (parent && (parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE')) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const textNodes: Text[] = []
  let cur: Node | null
  while ((cur = walker.nextNode())) textNodes.push(cur as Text)
  const matches: HTMLElement[] = []
  for (const node of textNodes) {
    const text = node.nodeValue as string
    const lowerText = text.toLowerCase()
    let idx = lowerText.indexOf(lower)
    if (idx === -1) continue
    const frag = document.createDocumentFragment()
    let last = 0
    while (idx !== -1) {
      if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)))
      const mark = document.createElement('mark')
      mark.className = MARK_CLASS
      mark.textContent = text.slice(idx, idx + q.length)
      frag.appendChild(mark)
      matches.push(mark)
      last = idx + q.length
      idx = lowerText.indexOf(lower, last)
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)))
    node.parentNode?.replaceChild(frag, node)
  }
  return matches
}

export function PreviewFindBar({ containerRef }: PreviewFindBarProps): React.ReactElement {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [matchCount, setMatchCount] = useState(0)
  const matchesRef = useRef<HTMLElement[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  const applyActive = useCallback((list: HTMLElement[], i: number) => {
    list.forEach((m, k) => {
      if (k === i) {
        m.classList.add(ACTIVE_CLASS)
        // jsdom has no layout engine, so scrollIntoView is a no-op and its call path is
        // unreachable under unit tests; the real call is a harmless scroll-to-center.
        /* v8 ignore next -- jsdom does not implement scrollIntoView */
        if (typeof m.scrollIntoView === 'function') m.scrollIntoView({ block: 'center' })
      } else {
        m.classList.remove(ACTIVE_CLASS)
      }
    })
  }, [])

  const doSearch = useCallback(
    (q: string) => {
      const el = containerRef.current
      /* v8 ignore next -- containerRef is always set while the component is mounted */
      if (!el) return
      const list = runSearch(el, q)
      matchesRef.current = list
      setMatchCount(list.length)
      if (list.length > 0) {
        setIndex(0)
        applyActive(list, 0)
      } else {
        setIndex(0)
      }
    },
    [applyActive, containerRef],
  )

  // Run the search whenever the query (or the open state) changes.
  useEffect(() => {
    if (!open) return
    doSearch(query)
  }, [open, query, doSearch])

  // Focus the input as soon as the bar opens.
  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
  }, [open])

  // Ctrl/Cmd+F inside the preview pane opens the in-pane find bar.
  useEffect(() => {
    const el = containerRef.current
    /* v8 ignore next -- containerRef is always set while the component is mounted */
    if (!el) return
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setOpen(true)
      }
    }
    el.addEventListener('keydown', handler)
    return () => el.removeEventListener('keydown', handler)
  }, [containerRef])

  const go = (delta: number) => {
    const list = matchesRef.current
    if (list.length === 0) return
    const next = (index + delta + list.length) % list.length
    setIndex(next)
    applyActive(list, next)
  }

  const close = () => {
    const el = containerRef.current
    /* v8 ignore next -- containerRef is always set while the component is mounted */
    if (el) clearMarks(el)
    matchesRef.current = []
    setMatchCount(0)
    setOpen(false)
    setQuery('')
    setIndex(0)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      go(e.shiftKey ? -1 : 1)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        data-testid="preview-find-btn"
        aria-label={t('preview.find')}
        onClick={() => setOpen(true)}
        className="absolute top-2 right-2 z-20 p-1.5 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-tertiary)] hover:text-accent transition-colors"
      >
        <Search size={14} />
      </button>
    )
  }

  const count = matchCount
  return (
    <div
      data-testid="preview-find-bar"
      className="absolute top-2 right-2 z-20 flex items-center gap-1 p-1.5 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] shadow-lg"
    >
      <Search size={13} className="text-[var(--color-text-tertiary)] shrink-0" />
      <input
        ref={inputRef}
        data-testid="preview-find-input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t('preview.findPlaceholder')}
        className="w-40 bg-transparent text-sm outline-none text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)]"
      />
      <span
        data-testid="preview-find-count"
        className="text-2xs text-[var(--color-text-tertiary)] shrink-0 min-w-[2.5rem] text-center"
      >
        {count === 0 ? t('preview.findNone') : `${index + 1} / ${count}`}
      </span>
      <button
        type="button"
        data-testid="preview-find-prev"
        aria-label={t('preview.findPrev')}
        onClick={() => go(-1)}
        className="p-1 rounded hover:bg-[var(--color-surface-overlay)]"
      >
        <ChevronUp size={13} />
      </button>
      <button
        type="button"
        data-testid="preview-find-next"
        aria-label={t('preview.findNext')}
        onClick={() => go(1)}
        className="p-1 rounded hover:bg-[var(--color-surface-overlay)]"
      >
        <ChevronDown size={13} />
      </button>
      <button
        type="button"
        data-testid="preview-find-close"
        aria-label={t('preview.findClose')}
        onClick={close}
        className="p-1 rounded hover:bg-[var(--color-surface-overlay)]"
      >
        <X size={13} />
      </button>
    </div>
  )
}
