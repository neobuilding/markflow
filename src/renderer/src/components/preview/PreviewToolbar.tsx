import React, { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react'
import { Search, FileOutput, Copy, MoreHorizontal, CodeXml } from 'lucide-react'
import { FindWidget } from '../editor/FindWidget'
import {
  TOGGLE_FIELD,
  withToggle,
  type FindToggleKey,
  type FindToggleState,
} from '../../lib/find-toggles'
import { useT } from '../../i18n'
import { useUIStore, selectFileLocked } from '../../store/ui'
import { requestRichCopy } from '../../lib/previewCopy'
import { formatShortcut } from '../../lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { BAR_PADDING, useOverflowFocus, usePriorityOverflow } from '../ui/priority-overflow'

interface PreviewToolbarProps {
  // The scrollable preview content element. Find highlighting is applied to its
  // text nodes (script/style subtrees are skipped).
  containerRef: React.RefObject<HTMLDivElement | null>
  // Export follows the preview's visibility (ADR-0024 §10 trade-off 46): the button
  // lives on this bar only when the preview is actually visible.
  previewVisible: boolean
  onExport: () => void
}

type PreviewCommandKey = 'find' | 'export' | 'copy' | 'copyHtml'

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

export function PreviewToolbar({
  containerRef,
  previewVisible,
  onExport,
}: PreviewToolbarProps): React.ReactElement {
  const { t } = useT()
  // R5 plan A: `setExportOpen` is refused while printing, so the export entry point on this bar
  // must be visibly disabled too. Find / copy stay available — they do not touch the document.
  const fileLocked = useUIStore(selectFileLocked)
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [toggleState, setToggleState] = useState<FindToggleState>({
    caseSensitive: false,
    wholeWord: false,
    regexp: false,
    preserveCase: false,
  })
  const inputRef = useRef<HTMLInputElement>(null)
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
    if (prev.count === next.count && prev.current === next.current) return
    snapshotRef.current = next
    listenersRef.current.forEach((l) => l())
  }, [])
  const { count, current } = useSyncExternalStore(subscribe, getSnapshot)
  const marksRef = useRef<HTMLElement[][]>([])
  const currentIndexRef = useRef(0)

  const clearMarks = () => {
    marksRef.current.flat().forEach((mark) => {
      const parent = mark.parentNode
      /* v8 ignore next -- defensive: a mark we just inserted into the preview is always attached */
      if (parent) {
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
        if (segs.length) pending.push(segs)
        if (m[0].length === 0) re.lastIndex += 1
      }
    })

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

  // Re-run highlighting on query/toggle change and on reopen (keep query across close, ADR-0023).
  // Gated on `findOpen` so closing (which clears marks) does not immediately re-apply them.
  useEffect(() => {
    if (findOpen) applySearch(query, toggleState)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, toggleState, findOpen])

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
    /* v8 ignore next -- defensive: the `preserve` toggle is never rendered in the preview */
    if (key === 'preserve') return
    const field = TOGGLE_FIELD[key]
    setToggleState((ts) => withToggle(ts, field, !ts[field]))
  }

  const onFindClose = () => {
    clearMarks()
    setFindOpen(false)
    publish(EMPTY_SNAPSHOT)
  }

  // Ctrl/Cmd+F in preview mode is routed here by EditorPane as a `preview:find` document event.
  useEffect(() => {
    const onOpen = () => setFindOpen(true)
    document.addEventListener('preview:find', onOpen)
    return () => document.removeEventListener('preview:find', onOpen)
  }, [])

  useEffect(() => {
    if (findOpen) inputRef.current?.focus()
  }, [findOpen])

  // Priority+ overflow: commands are ordered by descending priority, so the rightmost ones move
  // into the "…" trigger ONE AT A TIME as the column narrows. The trigger is CONDITIONAL — it is
  // rendered only while at least one command has overflowed (CONTEXT.md: "Conditional overflow
  // trigger"), so no command may depend on it as its only access path. Copy rendered HTML is an
  // ordinary, LOWEST-priority command: inline when there is room, an overflow entry when there is
  // not. There is no resident menu, and the committed screenshot baselines are not a design input.
  const barRef = useRef<HTMLDivElement>(null)
  // The commands are pure DATA (no callbacks). A command that needs the preview DOM resolves it
  // in an event handler, never while the array is built during render — holding a ref-reading
  // callback in that array makes react-hooks/refs reject every later render-time slice/map call.
  const runCommand = (key: PreviewCommandKey) => {
    switch (key) {
      case 'find':
        setFindOpen(true)
        break
      case 'export':
        onExport()
        break
      case 'copy': {
        const el = containerRef.current
        if (el) requestRichCopy(el)
        break
      }
      case 'copyHtml': {
        const el = containerRef.current
        if (el) void window.api.clipboard.writeText(el.innerHTML)
        break
      }
      default: {
        // Compile-time exhaustiveness: adding a command without a handler fails the build.
        const exhaustive: never = key
        return exhaustive
      }
    }
  }
  const commands: Array<{
    key: PreviewCommandKey
    icon: React.ComponentType<{ size?: number }>
    label: string
    tip?: string
    testId: string
    disabled?: boolean
  }> = [
    { key: 'find', icon: Search, label: t('preview.find'), testId: 'preview-find-btn' },
    ...(previewVisible
      ? [
          {
            key: 'export' as const,
            icon: FileOutput,
            label: t('editor.export'),
            tip: t('editor.exportShortcut', { shortcut: formatShortcut('⌘⇧X') }),
            testId: 'export-btn',
            disabled: fileLocked,
          },
        ]
      : []),
    {
      key: 'copy',
      icon: Copy,
      label: t('preview.copyRendered'),
      testId: 'preview-copy-btn',
    },
    {
      key: 'copyHtml',
      icon: CodeXml,
      label: t('preview.copyHtml'),
      testId: 'preview-copy-html-btn',
    },
  ]

  // This bar has no group separators, so its chrome is padding only (24px, not the editor bar's
  // 40px). Using the editor budget here would overflow 16px too early (168–183px columns).
  const visible = usePriorityOverflow(barRef, commands.length, BAR_PADDING)
  const inline = commands.slice(0, visible)
  const overflow = commands.slice(visible)
  useOverflowFocus(barRef, visible, commands.length)

  const renderInline = (cmd: (typeof commands)[number]) => {
    const Icon = cmd.icon
    return (
      <Tooltip key={cmd.key}>
        <TooltipTrigger asChild>
          <Button
            variant="toolbar"
            size="icon"
            data-testid={cmd.testId}
            data-command-index={commands.findIndex((c) => c.key === cmd.key)}
            aria-label={cmd.label}
            disabled={cmd.disabled}
            onClick={() => runCommand(cmd.key)}
          >
            <Icon size={16} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{cmd.tip ?? cmd.label}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <div
      ref={barRef}
      data-testid="preview-pane-bar"
      className="titlebar-no-drag flex items-center gap-1 px-3 h-9 border-b border-[var(--color-border)] bg-[var(--color-bg)] shrink-0"
    >
      {inline.map(renderInline)}

      {overflow.length > 0 && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="toolbar"
                  size="icon"
                  data-testid="preview-more-btn"
                  data-overflow-trigger
                  aria-label={t('preview.more')}
                >
                  <MoreHorizontal size={16} />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>{t('preview.more')}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            {overflow.map((cmd) => {
              const Icon = cmd.icon
              return (
                <DropdownMenuItem
                  key={cmd.key}
                  data-testid={cmd.testId}
                  disabled={cmd.disabled}
                  onClick={() => runCommand(cmd.key)}
                >
                  <Icon size={13} />
                  {cmd.label}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {findOpen && (
        <div className="absolute left-3 right-3 top-9 z-20">
          <div data-testid="preview-find-bar" className="find-surface">
            <FindWidget
              testId="preview-find"
              query={query}
              onQueryChange={setQuery}
              total={count}
              current={current}
              onPrev={() => goTo(-1)}
              onNext={() => goTo(1)}
              onClose={onFindClose}
              toggleState={toggleState}
              onToggle={onToggle}
              showReplace={false}
              inputRef={inputRef}
              placeholder={t('find.placeholder')}
            />
          </div>
        </div>
      )}
    </div>
  )
}
