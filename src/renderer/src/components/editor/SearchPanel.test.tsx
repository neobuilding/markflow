import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { SearchPanel } from './SearchPanel'
import type { SearchResult } from '../../types'

function makeResult(over: Partial<SearchResult> & { id: string }): SearchResult {
  return {
    title: 'Doc',
    folderPath: '',
    filePath: '/docs/doc.md',
    snippet: '',
    score: 0,
    updatedAt: 0,
    matches: [],
    ...over,
  }
}

const contentResults: SearchResult[] = [
  makeResult({
    id: 'a',
    title: 'Alpha',
    folderPath: '/docs',
    filePath: '/docs/alpha.md',
    matches: [
      { line: 1, start: 0, end: 3, excerpt: 'the cat sat', excerptStart: 0, excerptEnd: 3 },
      { line: 3, start: 20, end: 23, excerpt: 'and the dog ran', excerptStart: 4, excerptEnd: 7 },
    ],
  }),
  makeResult({
    id: 'b',
    title: 'Beta',
    matches: [
      { line: 2, start: 10, end: 13, excerpt: 'find the fox', excerptStart: 5, excerptEnd: 8 },
    ],
  }),
]

// Paths live under `/work` so the relative-path assertions have a real root to strip.
const fileResults: SearchResult[] = [
  makeResult({ id: 'a', title: 'Alpha', filePath: '/work/alpha.md', matches: [] }),
  makeResult({ id: 'b', title: 'Beta', filePath: '/work/beta.md', matches: [] }),
]

function renderPanel(props: Partial<React.ComponentProps<typeof SearchPanel>> = {}) {
  const onSelect = vi.fn()
  const onSelectMatch = vi.fn()
  const onModeChange = vi.fn()
  const onSelectIndex = vi.fn()
  const onShowDetails = vi.fn()
  const onToggleScopeAll = vi.fn()
  const utils = render(
    <>
      <SearchPanel
        results={[]}
        isFetching={false}
        query="the"
        searchMode="content"
        activeFolder={null}
        selectedIndex={0}
        onSelectIndex={onSelectIndex}
        onSelect={onSelect}
        onModeChange={onModeChange}
        onShowDetails={onShowDetails}
        {...props}
      />
    </>,
  )
  return {
    utils,
    onSelect,
    onSelectMatch,
    onSelectIndex,
    onModeChange,
    onShowDetails,
    onToggleScopeAll,
  }
}

beforeEach(() => {
  ;(window as any).api = { clipboard: { writeText: vi.fn() } }
})

describe('SearchPanel (Phase 4 resident mode)', () => {
  it('renders grouped hit rows with the matched substring highlighted', () => {
    const { utils } = renderPanel({ results: contentResults, onSelectMatch: vi.fn() })
    // Two groups (one per file) and three hit rows total.
    expect(screen.getAllByTestId('search-group')).toHaveLength(2)
    const rows = screen.getAllByTestId('search-match')
    expect(rows).toHaveLength(3)
    // The first hit row is highlighted as selected (selectedIndex = 0).
    expect(rows[0]).toHaveAttribute('data-selected', 'true')
    // The matched text is wrapped in <mark>.
    const marks = utils.container.querySelectorAll('mark')
    expect(marks.length).toBe(3)
    expect(marks[0].textContent).toBe('the')
  })

  it('escapes HTML in the excerpt so a document cannot inject markup', () => {
    const evil = makeResult({
      id: 'x',
      title: 'Evil',
      matches: [
        {
          line: 1,
          start: 4,
          end: 12,
          // The literal '<script>' sits inside the matched range.
          excerpt: 'hit <script> alert(1) </script> here',
          excerptStart: 4,
          excerptEnd: 12,
        },
      ],
    })
    const { utils } = renderPanel({ results: [evil], onSelectMatch: vi.fn() })
    // No real script element is ever created.
    expect(utils.container.querySelector('script')).toBeNull()
    // The angle brackets are escaped in the output.
    expect(utils.container.innerHTML).toContain('&lt;script&gt;')
    // The <mark> still wraps the matched (escaped) range.
    expect(utils.container.querySelector('mark')?.textContent).toBe('<script>')
  })

  it('jumps to the hit offset when a match row is clicked', () => {
    const onSelectMatch = vi.fn()
    renderPanel({ results: contentResults, onSelectMatch })
    fireEvent.click(screen.getAllByTestId('search-match')[1])
    expect(onSelectMatch).toHaveBeenCalledWith('a', 20, 23)
  })

  it('reports the hovered hit index so the parent can follow the mouse', () => {
    const onSelectIndex = vi.fn()
    renderPanel({ results: contentResults, onSelectMatch: vi.fn(), onSelectIndex })
    fireEvent.mouseEnter(screen.getAllByTestId('search-match')[1])
    expect(onSelectIndex).toHaveBeenCalledWith(1) // 0-based flat hit index
  })

  it('exposes every group-header context-menu action', async () => {
    const onSelect = vi.fn()
    const onShowDetails = vi.fn()
    const writeText = (window as any).api.clipboard.writeText as ReturnType<typeof vi.fn>
    renderPanel({ results: contentResults, onSelectMatch: vi.fn(), onSelect, onShowDetails })
    const openOn = async (item: string) => {
      fireEvent.contextMenu(screen.getAllByTestId('search-group')[0])
      fireEvent.click(await screen.findByTestId(item))
    }
    await openOn('palette-open-document')
    expect(onSelect).toHaveBeenCalledWith('a')
    await openOn('palette-copy-title')
    expect(writeText).toHaveBeenCalledWith('Alpha')
    await openOn('palette-copy-result-path')
    expect(writeText).toHaveBeenCalledWith('/docs/alpha.md')
    await openOn('palette-copy-folder-path')
    expect(writeText).toHaveBeenCalledWith('/docs')
    await openOn('palette-details')
    expect(onShowDetails).toHaveBeenCalledWith('a')
  })

  it('opens the document (without jumping) when a group header is clicked', () => {
    const onSelect = vi.fn()
    renderPanel({ results: contentResults, onSelect, onSelectMatch: vi.fn() })
    fireEvent.click(screen.getAllByTestId('search-group')[0])
    expect(onSelect).toHaveBeenCalledWith('a')
  })

  it('shows the global hit summary and the truncation note', () => {
    const truncated = contentResults.map((r) => ({ ...r, truncated: true }))
    renderPanel({ results: truncated, onSelectMatch: vi.fn() })
    const summary = screen.getByTestId('search-summary')
    expect(summary.textContent).toMatch(/3 matches in 2 files/)
    expect(screen.getByTestId('search-truncated')).toBeTruthy()
  })

  it('renders the All-documents scope toggle only when a folder is active', () => {
    const onToggleScopeAll = vi.fn()
    const { utils } = renderPanel({
      results: contentResults,
      onSelectMatch: vi.fn(),
      activeFolder: 'work',
      scopeAll: false,
      onToggleScopeAll,
    })
    const allBtn = screen.getByTestId('search-scope-all')
    fireEvent.click(allBtn)
    expect(onToggleScopeAll).toHaveBeenCalledWith(true)
    // Clicking "This folder" scopes back to the active folder.
    fireEvent.click(screen.getByTestId('search-scope-infolder'))
    expect(onToggleScopeAll).toHaveBeenCalledWith(false)
    // With no active folder the resident panel shows NO scope control at all — not a disabled
    // toggle and not a text label: there is only the workspace to search, so a control would just
    // be noise in the already-narrow sidebar.
    utils.rerender(
      <>
        <SearchPanel
          results={contentResults}
          isFetching={false}
          query="the"
          searchMode="content"
          activeFolder={null}
          selectedIndex={0}
          onSelectIndex={vi.fn()}
          onSelect={vi.fn()}
          onModeChange={vi.fn()}
          onShowDetails={vi.fn()}
          onSelectMatch={vi.fn()}
          // Still the RESIDENT panel (onToggleScopeAll is what marks it as such) — without it this
          // would render the Ctrl/Cmd+K palette variant, which legitimately keeps the text label.
          onToggleScopeAll={onToggleScopeAll}
        />
      </>,
    )
    expect(screen.queryByTestId('search-scope-all')).toBeNull()
    expect(screen.queryByTestId('search-scope-infolder')).toBeNull()
    expect(screen.queryByTestId('search-scope')).toBeNull()
  })

  it('omits the scope text label in resident mode (the toggle conveys it; avoids the cramped row)', () => {
    renderPanel({
      results: contentResults,
      onSelectMatch: vi.fn(),
      activeFolder: 'work',
      scopeAll: false,
      onToggleScopeAll: vi.fn(),
    })
    // The resident panel shows the compact ICON-ONLY scope control, not the long "Current folder
    // and its sub-folders" label that overflowed the narrow sidebar and broke the CJK text one
    // character per line once the row wrapped.
    expect(screen.queryByTestId('search-scope')).toBeNull()
    const all = screen.getByTestId('search-scope-all')
    const inFolder = screen.getByTestId('search-scope-infolder')
    expect(all).toBeTruthy()
    expect(inFolder).toBeTruthy()
    // Icons carry no text, so the meaning has to survive in the accessible name.
    expect(all.getAttribute('aria-label')).toBeTruthy()
    expect(inFolder.getAttribute('aria-label')).toBeTruthy()
  })
})

describe('SearchPanel (modal file-name mode, unchanged behavior)', () => {
  it('renders flat file rows and opens on click', () => {
    const onSelect = vi.fn()
    renderPanel({
      results: fileResults,
      searchMode: 'filename',
      query: 'Alpha',
      onSelectMatch: undefined,
      onSelect,
    })
    const rows = screen.getAllByTestId('search-result')
    expect(rows).toHaveLength(2)
    fireEvent.click(rows[0])
    expect(onSelect).toHaveBeenCalledWith('a')
  })

  it('shows the "no results" message for a resident query with no hits', () => {
    renderPanel({ results: [], query: 'zzz', onSelectMatch: vi.fn() })
    expect(screen.getByText('No results')).toBeTruthy()
  })

  it('shows "no results" instead of a blank list when no document has a literal hit', () => {
    // A fuzzy/prefix match can return documents whose body holds no literal term, so the
    // grouped list filters them all out. That must read as "no results", not an empty panel.
    const fuzzyOnly = [makeResult({ id: 'a', title: 'Alpha', matches: [] })]
    renderPanel({ results: fuzzyOnly, query: 'alpa', onSelectMatch: vi.fn() })
    expect(screen.getByText('No results')).toBeTruthy()
    expect(screen.queryByTestId('search-group')).toBeNull()
    expect(screen.queryByTestId('search-summary')).toBeNull()
  })

  it('renders the result path relative to the active folder (ADR-0013 §4)', () => {
    renderPanel({
      results: fileResults,
      searchMode: 'filename',
      query: 'Alpha',
      activeFolder: '/work',
      onSelectMatch: vi.fn(),
    })
    // Stored absolute path is shown folder-relative.
    expect(screen.getAllByTestId('search-result-path')[0].textContent).toBe('alpha.md')
  })

  it('falls back to the stored path when no folder is open (no root to be relative to)', () => {
    renderPanel({
      results: fileResults,
      searchMode: 'filename',
      query: 'Alpha',
      activeFolder: null,
      onSelectMatch: vi.fn(),
    })
    expect(screen.getAllByTestId('search-result-path')[0].textContent).toBe('/work/alpha.md')
  })

  it('still copies the ABSOLUTE path from the context menu', async () => {
    const writeText = (window as any).api.clipboard.writeText as ReturnType<typeof vi.fn>
    renderPanel({
      results: fileResults,
      searchMode: 'filename',
      query: 'Alpha',
      activeFolder: '/work',
      onSelectMatch: vi.fn(),
    })
    fireEvent.contextMenu(screen.getAllByTestId('search-result')[0])
    fireEvent.click(await screen.findByTestId('palette-copy-result-path'))
    // A relative path would be useless once pasted, so the copy stays absolute.
    expect(writeText).toHaveBeenCalledWith('/work/alpha.md')
  })

  it('renders the glob hint in filename mode on the resident surface only', () => {
    const { utils } = renderPanel({
      results: fileResults,
      searchMode: 'filename',
      query: 'Alpha',
      onSelectMatch: vi.fn(),
    })
    expect(screen.getByTestId('search-glob-hint')).toBeTruthy()
    // The Ctrl/Cmd+K modal passes no onSelectMatch and keeps its existing chrome.
    utils.rerender(
      <>
        <SearchPanel
          results={fileResults}
          isFetching={false}
          query="Alpha"
          searchMode="filename"
          activeFolder={null}
          selectedIndex={0}
          onSelectIndex={vi.fn()}
          onSelect={vi.fn()}
          onModeChange={vi.fn()}
          onShowDetails={vi.fn()}
        />
      </>,
    )
    expect(screen.queryByTestId('search-glob-hint')).toBeNull()
  })

  it('annotates the hit summary for screen readers and formats the group count', () => {
    renderPanel({ results: contentResults, onSelectMatch: vi.fn() })
    // Q19: counters are announced politely.
    expect(screen.getByTestId('search-summary')).toHaveAttribute('aria-live', 'polite')
    // §3.8: the group header renders "file name (hit count)".
    const alpha = screen
      .getAllByTestId('search-group')
      .find((g) => g.textContent?.includes('Alpha'))
    expect(within(alpha as HTMLElement).getByTestId('search-group-count').textContent).toBe('(2)')
  })

  it('does not render grouped hit rows in modal content mode', () => {
    renderPanel({ results: contentResults, onSelectMatch: undefined })
    expect(screen.queryByTestId('search-group')).toBeNull()
    expect(screen.queryByTestId('search-match')).toBeNull()
    // Modal still shows the flat file rows.
    expect(screen.getAllByTestId('search-result').length).toBeGreaterThan(0)
  })
})
