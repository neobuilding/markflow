import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SidebarSearch } from './SidebarSearch'
import { useUIStore } from '../../store/ui'
import type { SearchResult } from '../../types'

function makeResult(over: Partial<SearchResult> & { documentId: string }): SearchResult {
  return {
    title: 'Doc',
    relPath: 'doc.md',
    filePath: '/docs/doc.md',
    matchCount: 0,
    matchCapped: false,
    matches: [],
    ...over,
  }
}

const contentResults: SearchResult[] = [
  makeResult({
    documentId: 'a',
    title: 'Alpha',
    matchCount: 2,
    matches: [
      {
        line: 1,
        start: 0,
        end: 3,
        lineSpan: 1,
        excerpt: 'the cat sat',
        excerptStart: 0,
        excerptEnd: 3,
      },
      {
        line: 3,
        start: 20,
        end: 23,
        lineSpan: 1,
        excerpt: 'and the dog ran',
        excerptStart: 4,
        excerptEnd: 7,
      },
    ],
  }),
  makeResult({
    documentId: 'b',
    title: 'Beta',
    matchCount: 1,
    matches: [
      {
        line: 2,
        start: 10,
        end: 13,
        lineSpan: 1,
        excerpt: 'find the fox',
        excerptStart: 5,
        excerptEnd: 8,
      },
    ],
  }),
]

let scope: { root: string | null; include: string[]; exclude: string[] } = {
  root: '/ws',
  include: [],
  exclude: [],
}
let diagnostics: Array<{ code: string; blocking: boolean; field?: string; pattern?: string }> = []

function renderPanel() {
  const client = new QueryClient()
  return render(
    <QueryClientProvider client={client}>
      <SidebarSearch />
    </QueryClientProvider>,
  )
}

// The Search view owns a visible scope, so the mock has to be able to report the applied root 鈥?// that is what decides whether the include/exclude fields are usable.
vi.mock('../../hooks/useSearch', () => ({
  useSearchView: () => ({
    data: {
      results: (globalThis as unknown as { __results: SearchResult[] }).__results ?? contentResults,
      diagnostics:
        (globalThis as unknown as { __diagnostics: typeof diagnostics }).__diagnostics ?? [],
      appliedScope: (globalThis as unknown as { __scope: typeof scope }).__scope ?? scope,
      truncated: false,
    },
    isFetching: false,
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  scope = { root: '/ws', include: [], exclude: [] }
  diagnostics = []
  ;(globalThis as unknown as { __results: SearchResult[] }).__results = contentResults
  ;(globalThis as unknown as { __diagnostics: typeof diagnostics }).__diagnostics = diagnostics
  ;(globalThis as unknown as { __scope: typeof scope }).__scope = scope
  useUIStore.setState({
    searchQuery: '',
    searchInclude: '',
    searchExclude: '',
    searchMatchCase: false,
    searchWholeWord: false,
    searchRegexp: false,
    searchReplaceText: '',
    searchReplaceOpen: false,
    searchDetailsOpen: false,
    pendingMatch: null,
    activeDocumentId: null,
    dirty: false,
  })
  ;(window as unknown as { api: unknown }).api = {
    clipboard: { writeText: vi.fn() },
    replace: { plan: vi.fn(), apply: vi.fn(), cancel: vi.fn(), undo: vi.fn() },
    dialog: { confirm: vi.fn().mockResolvedValue(true) },
  }
})

describe('SidebarSearch (Search view)', () => {
  it('renders the query field, the toggle group and the replace chevron', () => {
    renderPanel()
    expect(screen.getByTestId('resident-search-input')).toBeTruthy()
    expect(screen.getByTestId('search-match-case')).toBeTruthy()
    expect(screen.getByTestId('search-toggle-replace')).toBeTruthy()
  })

  it('Match Case defaults OFF and toggles to ON', () => {
    renderPanel()
    // The toggles share the `search-match-case` group id; the individual buttons are suffixed.
    const aa = screen.getByTestId('search-match-case-Aa')
    expect(aa.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(aa)
    expect(useUIStore.getState().searchMatchCase).toBe(true)
  })

  it('exposes whole word and regexp toggles, both OFF by default', () => {
    renderPanel()
    const ab = screen.getByTestId('search-match-case-ab')
    const re = screen.getByTestId('search-match-case-.*')
    expect(ab.getAttribute('aria-pressed')).toBe('false')
    expect(re.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(ab)
    fireEvent.click(re)
    expect(useUIStore.getState().searchWholeWord).toBe(true)
    expect(useUIStore.getState().searchRegexp).toBe(true)
    expect(ab.getAttribute('aria-pressed')).toBe('true')
    expect(re.getAttribute('aria-pressed')).toBe('true')
  })

  it('shows the regex hint only while regexp is on', () => {
    renderPanel()
    expect(screen.queryByTestId('search-regex-hint')).toBeNull()
    fireEvent.click(screen.getByTestId('search-match-case-.*'))
    expect(screen.getByTestId('search-regex-hint').textContent).toContain('\\n')
  })

  it('renders grouped hit rows and jumps the editor on a hit click', async () => {
    renderPanel()
    fireEvent.change(screen.getByTestId('resident-search-input'), { target: { value: 'the' } })
    const rows = await screen.findAllByTestId('search-match')
    expect(rows.length).toBe(3)
    fireEvent.click(rows[1])
    expect(useUIStore.getState().pendingMatch).toEqual({ id: 'a', start: 20, end: 23 })
    expect(useUIStore.getState().activeDocumentId).toBe('a')
  })

  it('shows the REAL hit count per file, not the capped display count', async () => {
    ;(globalThis as unknown as { __results: SearchResult[] }).__results = [
      makeResult({
        documentId: 'z',
        title: 'Zeta',
        matchCount: 137,
        matchCapped: true,
        matches: [
          {
            line: 1,
            start: 0,
            end: 3,
            lineSpan: 1,
            excerpt: 'the cat',
            excerptStart: 0,
            excerptEnd: 3,
          },
        ],
      }),
    ]
    renderPanel()
    fireEvent.change(screen.getByTestId('resident-search-input'), { target: { value: 'the' } })
    expect((await screen.findByTestId('search-group-count')).textContent).toBe('(137)')
  })

  it('navigation keys move the selection and Enter jumps', async () => {
    renderPanel()
    const input = screen.getByTestId('resident-search-input')
    fireEvent.change(input, { target: { value: 'the' } })
    await screen.findAllByTestId('search-match')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(useUIStore.getState().pendingMatch).toEqual({ id: 'a', start: 0, end: 3 })
  })

  it('clears the query with the X button', async () => {
    renderPanel()
    const input = screen.getByTestId('resident-search-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'the' } })
    await screen.findAllByTestId('search-match')
    fireEvent.click(screen.getByTestId('resident-search-clear'))
    await waitFor(() => expect(useUIStore.getState().searchQuery).toBe(''))
  })

  it('hides the replace row behind the chevron and reveals it on demand', () => {
    renderPanel()
    expect(screen.queryByTestId('search-replace-input')).toBeNull()
    fireEvent.click(screen.getByTestId('search-toggle-replace'))
    expect(screen.getByTestId('search-replace-input')).toBeTruthy()
    expect(screen.getByTestId('search-replace-all')).toBeTruthy()
  })

  it('reveals include / exclude under Search details and writes them to the store', () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('search-toggle-details'))
    const include = screen.getByTestId('search-include')
    fireEvent.change(include, { target: { value: './docs' } })
    expect(useUIStore.getState().searchInclude).toBe('./docs')
  })

  // A non-empty scope must never be hidden 鈥?that was the whole complaint that started this plan
  //.
  it('forces the details block open when a scope is set', () => {
    useUIStore.setState({ searchInclude: './docs', searchDetailsOpen: false })
    renderPanel()
    expect(screen.getByTestId('search-include')).toBeTruthy()
  })

  it('disables the scope fields when there is no workspace root', () => {
    ;(globalThis as unknown as { __scope: typeof scope }).__scope = {
      root: null,
      include: [],
      exclude: [],
    }
    renderPanel()
    fireEvent.click(screen.getByTestId('search-toggle-details'))
    expect((screen.getByTestId('search-include') as HTMLInputElement).disabled).toBe(true)
  })

  it('surfaces a blocking diagnostic instead of silently searching', () => {
    ;(globalThis as unknown as { __results: SearchResult[] }).__results = []
    ;(globalThis as unknown as { __diagnostics: typeof diagnostics }).__diagnostics = [
      { code: 'invalid-pattern', blocking: true, field: 'include', pattern: 'a[bc' },
    ]
    renderPanel()
    fireEvent.change(screen.getByTestId('resident-search-input'), { target: { value: 'the' } })
    const alert = screen.getByTestId('search-diagnostic')
    expect(alert.textContent).toContain('a[bc')
  })

  it('warns that multi-line queries are unsupported', () => {
    useUIStore.setState({ searchQuery: 'a\nb' })
    renderPanel()
    expect(screen.getByTestId('search-multiline')).toBeTruthy()
  })

  it('does not switch documents when the unsaved guard is declined', async () => {
    const confirm = vi.fn(async () => false)
    ;(window as unknown as { api: unknown }).api = {
      clipboard: { writeText: vi.fn() },
      replace: { plan: vi.fn(), apply: vi.fn(), cancel: vi.fn(), undo: vi.fn() },
      dialog: { confirm },
    }
    useUIStore.setState({ activeDocumentId: 'zz', dirty: true })
    renderPanel()
    fireEvent.change(screen.getByTestId('resident-search-input'), { target: { value: 'the' } })
    const rows = await screen.findAllByTestId('search-match')
    fireEvent.click(rows[0])
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(useUIStore.getState().activeDocumentId).toBe('zz')
    // A declined jump must not write pendingMatch either: the editor would otherwise jump
    // into a document that was never opened.
    expect(useUIStore.getState().pendingMatch).toBeNull()
  })

  // D19 / §5.2: a non-empty scope excludes memory drafts, and the result area must SAY so —
  // silently shrinking the result set is what this plan outlawed.
  it('explains that drafts are excluded when a scope is set', async () => {
    ;(globalThis as unknown as { __diagnostics: unknown }).__diagnostics = [
      { code: 'drafts-excluded', blocking: false, message: 'drafts excluded by scope' },
    ]
    renderPanel()
    fireEvent.change(screen.getByTestId('resident-search-input'), { target: { value: 'the' } })
    const info = await screen.findByTestId('search-diagnostic-info')
    expect(info.textContent).toMatch(/草稿|drafts/)
    // The raw main-process message stays available as the tooltip (contract field kept).
    expect(info.querySelector('[title]')?.getAttribute('title')).toBe('drafts excluded by scope')
  })

  // §5.8: path-not-found is its own domain — it must never be rendered as "invalid pattern",
  // which would send the user hunting for a syntax error that does not exist.
  it('renders path-not-found as its own diagnostic, not as an invalid pattern', async () => {
    ;(globalThis as unknown as { __diagnostics: unknown }).__diagnostics = [
      { code: 'path-not-found', blocking: true, pattern: './nope', message: 'path not found' },
    ]
    renderPanel()
    fireEvent.change(screen.getByTestId('resident-search-input'), { target: { value: 'the' } })
    const diag = await screen.findByTestId('search-diagnostic')
    expect(diag.textContent).toContain('./nope')
    expect(diag.textContent).not.toMatch(/无效|Invalid pattern/)
  })

  // D28 / ADR-0023 item 15: §5.2 lets unsaved buffers be SEARCHED while §5.5.3 makes replace skip
  // them, so a user can find text they cannot replace. The plan names the files it dropped —
  // "0 files" with no reason leaves the user unable to tell "no match" from "not saved yet".
  it('says when the replace plan dropped files because they have unsaved edits', async () => {
    const plan = vi.fn(async () => ({
      ok: true,
      plan: {
        planId: 'p1',
        fileCount: 0,
        matchCount: 0,
        skipped: [{ documentId: 'a', relPath: 'a.md', reason: 'unsaved' }],
      },
    }))
    const apply = vi.fn()
    ;(window as unknown as { api: unknown }).api = {
      clipboard: { writeText: vi.fn() },
      replace: { plan, apply, cancel: vi.fn(), undo: vi.fn() },
      dialog: { confirm: vi.fn().mockResolvedValue(true) },
      onReplaceProgress: vi.fn(() => () => {}),
    }
    useUIStore.setState({ searchQuery: 'cat', searchReplaceText: 'dog', searchReplaceOpen: true })
    renderPanel()
    fireEvent.click(screen.getByTestId('search-replace-all'))
    const note = await screen.findByTestId('search-replace-skipped')
    expect(note.textContent).toMatch(/未保存|unsaved/i)
    // Nothing to write, so nothing may be confirmed or applied.
    expect(apply).not.toHaveBeenCalled()
  })

  // The mirror image: `no-hit` is the normal case (a file that simply does not contain the
  // needle), so it must NOT be reported — a note for it would be noise on every single plan.
  it('prints no skip note when the only dropped files had no hit', async () => {
    const plan = vi.fn(async () => ({
      ok: true,
      plan: {
        planId: 'p2',
        fileCount: 0,
        matchCount: 0,
        skipped: [{ documentId: 'a', relPath: 'a.md', reason: 'no-hit' }],
      },
    }))
    ;(window as unknown as { api: unknown }).api = {
      clipboard: { writeText: vi.fn() },
      replace: {
        plan,
        apply: vi.fn(async () => ({
          ok: true,
          replaced: 1,
          files: [{ documentId: 'a', relPath: 'a.md', status: 'ok', replaced: 1 }],
        })),
        cancel: vi.fn(),
        undo: vi.fn(),
      },
      dialog: { confirm: vi.fn().mockResolvedValue(true) },
      onReplaceProgress: vi.fn(() => () => {}),
    }
    useUIStore.setState({ searchQuery: 'cat', searchReplaceText: 'dog', searchReplaceOpen: true })
    renderPanel()
    fireEvent.click(screen.getByTestId('search-replace-all'))
    await screen.findByTestId('search-replace-plan')
    expect(screen.queryByTestId('search-replace-skipped')).toBeNull()
  })

  // §5.5.3: a symlink (or a stale record) can point a root-internal path at a file outside the
  // workspace; the plan refuses to write through it, and the panel must say so.
  it('says when the replace plan dropped a document outside the workspace root', async () => {
    const plan = vi.fn(async () => ({
      ok: true,
      plan: {
        planId: 'p3',
        fileCount: 0,
        matchCount: 0,
        skipped: [{ documentId: 'x', relPath: 'link.md', reason: 'out-of-root' }],
      },
    }))
    ;(window as unknown as { api: unknown }).api = {
      clipboard: { writeText: vi.fn() },
      replace: { plan, apply: vi.fn(), cancel: vi.fn(), undo: vi.fn() },
      dialog: { confirm: vi.fn().mockResolvedValue(true) },
      onReplaceProgress: vi.fn(() => () => {}),
    }
    useUIStore.setState({ searchQuery: 'cat', searchReplaceText: 'dog', searchReplaceOpen: true })
    renderPanel()
    fireEvent.click(screen.getByTestId('search-replace-all'))
    const note = await screen.findByTestId('search-replace-skipped')
    expect(note.textContent).toMatch(/工作区|workspace/i)
  })
})
