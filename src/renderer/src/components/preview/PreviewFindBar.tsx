import React, { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react'
import { Search } from 'lucide-react'
import { FindWidget } from '../editor/FindWidget'
import {
  TOGGLE_FIELD,
  withToggle,
  type FindToggleKey,
  type FindToggleState,
} from '../../lib/find-toggles'
import { useT } from '../../i18n'

interface PreviewFindBarProps {
  // The scrollable preview content element. Find highlighting is applied to its
  // text nodes (script/style subtrees are skipped).
  containerRef: React.RefObject<HTMLDivElement | null>
}

// The k/n counter is NOT React state: it is the number of <mark> elements we insert into the
// preview DOM, which React does not own and which can only be counted by walking that DOM —
// an impure read that cannot happen during render. Publishing it through this small external
// store lets `useSyncExternalStore` read it during render, instead of calling setState inside
// an effect (which react-hooks/set-state-in-effect forbids, and which costs an extra render).
type PreviewSearchSnapshot = { count: number; current: number }
const EMPTY_SNAPSHOT: PreviewSearchSnapshot = { count: 0, current: 0 }

// Build a RegExp from the user's query + toggles. Plain text is escaped; whole-word
// wraps the pattern in lookarounds so it works for both plain and regexp queries.
function buildPreviewRegex(query: string, ts: FindToggleState): RegExp | null {
  let src = ts.regexp ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (ts.wholeWord) src = `(?<!\\w)(?:${src})(?!\\w)`
  try {
    return new RegExp(src, ts.caseSensitive ? 'g' : 'gi')
  } catch {
    return null
  }
}

// Elements that start a fresh "text run". A match never spans one, so this behaves like the
// browser's own find: it stops at block boundaries instead of matching the last word of one
// paragraph against the first word of the next. `BR` belongs here too — a markdown hard break
// renders as a <br> INSIDE one <p>, so without it a query could match across the line break.
const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'BR',
  'DD',
  'DETAILS',
  'DIALOG',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'SUMMARY',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL',
])

// KaTeX renders every formula TWICE: a visually hidden MathML copy (`.katex-mathml`, clipped to a
// 1px box by KaTeX's stylesheet) and the visible HTML copy (`.katex-html`). Both carry the same
// characters, so without this filter one formula yields an invisible "match" that inflates the
// counter and that next/prev scrolls to — "1 / 3" pointing at nothing, with one of the three
// highlights impossible to see. Only the visible copy is searchable. It cannot be identified by
// aria-hidden: the VISIBLE copy is the one marked `aria-hidden="true"`, so the hidden MathML must
// be recognised by name.
function isHiddenMathml(el: Element): boolean {
  return el.classList.contains('katex-mathml')
}

// Collect the container's text nodes as "runs": consecutive text nodes whose characters are
// rendered contiguously. Inline elements (the bulk of both markdown output and KaTeX's visible
// HTML) do NOT break a run, which is what lets a match span sibling elements — KaTeX emits one
// span per character (`<span class="mord mathnormal">m</span>…<span…>c</span>`), so a
// per-text-node search could never find "mc" inside a formula.
function collectTextRuns(root: Element): Text[][] {
  const runs: Text[][] = []
  let run: Text[] = []
  const flush = () => {
    if (run.length) {
      runs.push(run)
      run = []
    }
  }
  const visit = (el: Element) => {
    el.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        run.push(child as Text)
        return
      }
      if (child.nodeType !== Node.ELEMENT_NODE) return
      const childEl = child as Element
      if (childEl.tagName === 'SCRIPT' || childEl.tagName === 'STYLE' || isHiddenMathml(childEl)) {
        return
      }
      if (BLOCK_TAGS.has(childEl.tagName)) {
        flush()
        visit(childEl)
        flush()
      } else {
        visit(childEl)
      }
    })
  }
  visit(root)
  flush()
  return runs
}

type Segment = { node: Text; from: number; to: number }

// Wrap one match. A match inside a single text node yields one <mark>; a match spanning sibling
// text nodes (see collectTextRuns) yields one <mark> per covered node, which still reads as one
// continuous highlight because those nodes are adjacent inline content.
function wrapSegments(segs: Segment[]): HTMLElement[] {
  const marks: HTMLElement[] = []
  segs.forEach(({ node, from, to }) => {
    // Split the tail first, so `node` keeps [0, to): splitText leaves the text BEFORE the offset
    // on the original node and returns the remainder as a new sibling.
    if (to < node.data.length) node.splitText(to)
    const piece = from > 0 ? node.splitText(from) : node
    const mark = document.createElement('mark')
    mark.className = 'preview-find-match'
    /* v8 ignore next -- defensive: a text node collected from the container always has a parent */
    if (piece.parentNode) piece.parentNode.replaceChild(mark, piece)
    mark.appendChild(piece)
    marks.push(mark)
  })
  return marks
}

// Preview find bar: a find-only surface that reuses the shared FindWidget shell.
// Matches are highlighted in the rendered preview DOM (not in an editor model), with the current
// match tagged `.preview-find-active` and scrolled into view. One match = a GROUP of <mark>
// elements (a match may span sibling nodes), so mark bookkeeping is per group, not per element.
export function PreviewFindBar({ containerRef }: PreviewFindBarProps): React.ReactElement {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [toggleState, setToggleState] = useState<FindToggleState>({
    caseSensitive: false,
    wholeWord: false,
    regexp: false,
    preserveCase: false,
  })
  // The bar's own input, focused when the bar opens (see the `open` effect below).
  const inputRef = useRef<HTMLInputElement>(null)
  // External store for the match counters (see the note on PreviewSearchSnapshot above).
  // `getSnapshot` must return a cached object, so the snapshot is only replaced on publish.
  const snapshotRef = useRef<PreviewSearchSnapshot>(EMPTY_SNAPSHOT)
  const listenersRef = useRef(new Set<() => void>())
  const subscribe = useCallback((onStoreChange: () => void) => {
    listenersRef.current.add(onStoreChange)
    return () => {
      listenersRef.current.delete(onStoreChange)
    }
  }, [])
  const getSnapshot = useCallback(() => snapshotRef.current, [])
  const publish = useCallback((next: PreviewSearchSnapshot) => {
    const prev = snapshotRef.current
    // Notify only on a real change — otherwise every effect run would force another render.
    if (prev.count === next.count && prev.current === next.current) return
    snapshotRef.current = next
    listenersRef.current.forEach((l) => l())
  }, [])
  const { count, current } = useSyncExternalStore(subscribe, getSnapshot)
  // One entry per MATCH; each entry holds that match's <mark> elements (usually one, more when the
  // match spans sibling nodes).
  const marksRef = useRef<HTMLElement[][]>([])
  const currentIndexRef = useRef(0)

  const clearMarks = () => {
    marksRef.current.flat().forEach((mark) => {
      const parent = mark.parentNode
      /* v8 ignore next -- defensive: a mark we just inserted into the preview is always attached */
      if (parent) {
        // normalize() re-joins the text nodes splitText carved out, restoring the original DOM.
        parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark)
        parent.normalize()
      }
    })
    marksRef.current = []
  }

  const updateActive = (idx: number) => {
    marksRef.current.forEach((marks, i) => {
      marks.forEach((m) => m.classList.toggle('preview-find-active', i === idx))
    })
    const el = marksRef.current[idx]?.[0]
    /* v8 ignore next -- defensive: idx always indexes an existing group, and jsdom has no scrollIntoView */
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  const applySearch = (q: string, ts: FindToggleState) => {
    clearMarks()
    const container = containerRef.current
    if (!container || !q) {
      publish(EMPTY_SNAPSHOT)
      return
    }
    const re = buildPreviewRegex(q, ts)
    if (!re) {
      publish(EMPTY_SNAPSHOT)
      return
    }

    // Find every match against the still-unmutated DOM, recording which text nodes it covers.
    // Collecting first (instead of wrapping as we go) is what makes a cross-node match work:
    // all offsets stay valid until the first mutation.
    const pending: Segment[][] = []
    collectTextRuns(container).forEach((nodes) => {
      const text = nodes.map((n) => n.data).join('')
      const bounds: { node: Text; start: number; end: number }[] = []
      let at = 0
      nodes.forEach((n) => {
        bounds.push({ node: n, start: at, end: at + n.data.length })
        at += n.data.length
      })
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text))) {
        const start = m.index
        const end = start + m[0].length
        const segs: Segment[] = []
        bounds.forEach((b) => {
          const from = Math.max(start, b.start)
          const to = Math.min(end, b.end)
          if (from < to) segs.push({ node: b.node, from: from - b.start, to: to - b.start })
        })
        // A zero-length match (e.g. the regexp "a*") covers no characters, so it is not a
        // highlightable match and must not inflate the counter.
        if (segs.length) pending.push(segs)
        // Guard against zero-length matches to avoid an infinite loop.
        if (m[0].length === 0) re.lastIndex += 1
      }
    })

    // Wrap back-to-front so the offsets recorded above are still valid while the DOM is mutated.
    const groups: HTMLElement[][] = []
    for (let i = pending.length - 1; i >= 0; i -= 1) groups.unshift(wrapSegments(pending[i]))

    marksRef.current = groups
    currentIndexRef.current = 0
    if (groups.length) {
      publish({ count: groups.length, current: 1 })
      updateActive(0)
    } else {
      publish(EMPTY_SNAPSHOT)
    }
  }

  // Re-run highlighting whenever the query or a toggle changes — and again whenever the bar
  // REOPENS. Closing clears the marks but deliberately KEEPS the query (plan §5.3 Q2), so without
  // re-applying on open the bar comes back with the query text still sitting in the box but zero
  // highlights and a stale "No match" counter. `open` in the deps is what restores them; when it
  // flips to false we skip, because onClose has already cleared the marks.
  useEffect(() => {
    if (open) applySearch(query, toggleState)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, toggleState, open])

  const goTo = (delta: number) => {
    const n = marksRef.current.length
    if (!n) return
    let idx = (currentIndexRef.current + delta) % n
    if (idx < 0) idx += n
    currentIndexRef.current = idx
    publish({ count: n, current: idx + 1 })
    updateActive(idx)
  }

  const onToggle = (key: FindToggleKey) => {
    // `preserve` is a replace-only toggle and is never rendered in the preview, so this
    // guard is unreachable from the UI. Hoisted out so `key` narrows to the three match toggles.
    /* v8 ignore next -- defensive: the `preserve` toggle is never rendered in the preview */
    if (key === 'preserve') return
    // Same key->field mapping the editor panel uses (lib/find-toggles), so the two surfaces can
    // never disagree about what `Aa` / `ab` / `.*` mean.
    const field = TOGGLE_FIELD[key]
    setToggleState((ts) => withToggle(ts, field, !ts[field]))
  }

  const onClose = () => {
    clearMarks()
    setOpen(false)
    // Keep `query` so reopening restores it — matching the editor find widget, which never
    // clears the query on close (plan §3.1: one interaction model for both find surfaces).
    publish(EMPTY_SNAPSHOT)
  }

  // Ctrl/Cmd+F in preview mode is routed here by EditorPane as a `preview:find` document event.
  // It cannot be a listener on the container: that is a plain non-focusable <div>, so clicking
  // the preview leaves focus on <body> and a keydown never reaches it — which is why Ctrl+F used
  // to do nothing at all in preview mode.
  useEffect(() => {
    const onOpen = () => setOpen(true)
    document.addEventListener('preview:find', onOpen)
    return () => document.removeEventListener('preview:find', onOpen)
  }, [])

  // Focus the query input once the bar is mounted, so Ctrl+F can be followed by typing.
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  if (!open) {
    return (
      <button
        type="button"
        data-testid="preview-find-btn"
        aria-label={t('find.placeholder')}
        title={t('find.placeholder')}
        onClick={() => setOpen(true)}
        // MUST be positioned. As a flow element following an `h-full` content div inside an
        // `overflow-hidden` parent it was laid out below the visible area and clipped away: the
        // pane had no reachable search button. (Playwright still clicked it, because a clipped
        // element keeps a bounding box — which is exactly why the suite stayed green.)
        className="absolute top-2 right-2 z-20 flex h-6 w-6 items-center justify-center rounded border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-tertiary)] shadow-sm transition-colors hover:text-accent"
      >
        <Search size={13} />
      </button>
    )
  }

  return (
    <div data-testid="preview-find-bar" className="find-surface">
      <FindWidget
        testId="preview-find"
        query={query}
        onQueryChange={setQuery}
        total={count}
        current={current}
        onPrev={() => goTo(-1)}
        onNext={() => goTo(1)}
        onClose={onClose}
        toggleState={toggleState}
        onToggle={onToggle}
        showReplace={false}
        inputRef={inputRef}
        placeholder={t('find.placeholder')}
      />
    </div>
  )
}
