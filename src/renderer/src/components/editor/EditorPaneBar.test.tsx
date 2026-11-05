import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { t, type TranslationKey } from '../../i18n'
import { EditorPaneBar } from './EditorPaneBar'
import { ALL_INLINE_AT } from '../ui/priority-overflow'
import { TooltipProvider } from '../ui/tooltip'
import { useUIStore } from '../../store/ui'
import { useEditorHistory } from '../../store/editorHistory'
import { formatShortcut, isMac } from '../../lib/utils'

// A controllable ResizeObserver: the bar's priority+ overflow is driven by COLUMN width, so the
// test has to be able to report a width. The global polyfill in test-setup.ts is a no-op (jsdom
// has no layout), which would leave every partially-overflowed state untested.
//
// Every constructed observer is collected, not just the last one: Radix's Popper (used by the
// overflow dropdown) also constructs a ResizeObserver, so keeping only the newest callback would
// hand the test someone else's observer.
//
// The mock reports the COLUMN width through `borderBoxSize`, exactly what the production code reads
// (EditorPaneBar.tsx measures the bar's border box). `contentRect` is reported alongside only so
// Radix's Popper gets a sane size; production deliberately ignores it.
type ResizeCallback = (
  entries: Array<{
    borderBoxSize: ReadonlyArray<{ inlineSize: number }>
    contentRect: { width: number }
  }>,
) => void
const observers: ResizeCallback[] = []

class MockResizeObserver {
  constructor(cb: ResizeCallback) {
    observers.push(cb)
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
// docs/agents/testing.md:121 — a stubbed global must be restored afterwards.
const OriginalResizeObserver = globalThis.ResizeObserver

// Report a column width to every live observer.
function reportWidth(width: number) {
  act(() => {
    observers.forEach((cb) =>
      cb([
        {
          borderBoxSize: [{ inlineSize: width }],
          contentRect: { width },
        },
      ]),
    )
  })
}

function renderBar(editable: boolean) {
  return render(
    <TooltipProvider>
      <EditorPaneBar editable={editable} />
    </TooltipProvider>,
  )
}

beforeEach(() => {
  observers.length = 0
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = MockResizeObserver
  useEditorHistory.getState().reset()
  useUIStore.getState().setEditable(false)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = OriginalResizeObserver
})

describe('EditorPaneBar', () => {
  it('renders the 7-button format cluster in the expanded layout', () => {
    renderBar(true)
    expect(screen.getByTestId('fmt-# -')).toBeInTheDocument()
    expect(screen.getByTestId('fmt-**-**')).toBeInTheDocument()
    expect(screen.getByTestId('fmt-_-_')).toBeInTheDocument()
    expect(screen.getByTestId('fmt-`-`')).toBeInTheDocument()
    expect(screen.getByTestId('fmt-[-](url)')).toBeInTheDocument()
    expect(screen.getByTestId('fmt-- -')).toBeInTheDocument()
    expect(screen.getByTestId('fmt-- [ ] -')).toBeInTheDocument()
    // The single overflow trigger is absent while the column is wide enough.
    expect(screen.queryByTestId('editor-overflow-btn')).toBeNull()
  })

  it("dispatches markdown:insert with the button's before/after pair", () => {
    const onInsert = vi.fn()
    document.addEventListener('markdown:insert', onInsert)
    renderBar(true)
    fireEvent.click(screen.getByTestId('fmt-**-**'))
    expect(onInsert).toHaveBeenCalledTimes(1)
    expect((onInsert.mock.calls[0][0] as CustomEvent).detail).toEqual({
      before: '**',
      after: '**',
    })
    document.removeEventListener('markdown:insert', onInsert)
  })

  it('disables the format buttons while the pane is read-only', () => {
    renderBar(false)
    expect(screen.getByTestId('fmt-**-**')).toBeDisabled()
  })

  it('dispatches markdown:find / markdown:replace from the find and replace buttons', () => {
    const onFind = vi.fn()
    const onReplace = vi.fn()
    document.addEventListener('markdown:find', onFind)
    document.addEventListener('markdown:replace', onReplace)
    renderBar(true)
    fireEvent.click(screen.getByTestId('editor-find-btn'))
    fireEvent.click(screen.getByTestId('editor-replace-btn'))
    expect(onFind).toHaveBeenCalledTimes(1)
    expect(onReplace).toHaveBeenCalledTimes(1)
    document.removeEventListener('markdown:find', onFind)
    document.removeEventListener('markdown:replace', onReplace)
  })

  it('keeps undo/redo disabled until the editor reports a history', () => {
    renderBar(true)
    expect(screen.getByTestId('editor-undo-btn')).toBeDisabled()
    expect(screen.getByTestId('editor-redo-btn')).toBeDisabled()
    act(() => {
      useEditorHistory.getState().update({ canUndo: true, canRedo: false })
    })
    expect(screen.getByTestId('editor-undo-btn')).toBeEnabled()
    expect(screen.getByTestId('editor-redo-btn')).toBeDisabled()
    act(() => {
      useEditorHistory.getState().update({ canUndo: true, canRedo: true })
    })
    expect(screen.getByTestId('editor-redo-btn')).toBeEnabled()
  })

  it('dispatches markdown:undo / markdown:redo', () => {
    const onUndo = vi.fn()
    const onRedo = vi.fn()
    document.addEventListener('markdown:undo', onUndo)
    document.addEventListener('markdown:redo', onRedo)
    act(() => {
      useEditorHistory.getState().update({ canUndo: true, canRedo: true })
    })
    renderBar(true)
    fireEvent.click(screen.getByTestId('editor-undo-btn'))
    fireEvent.click(screen.getByTestId('editor-redo-btn'))
    expect(onUndo).toHaveBeenCalledTimes(1)
    expect(onRedo).toHaveBeenCalledTimes(1)
    document.removeEventListener('markdown:undo', onUndo)
    document.removeEventListener('markdown:redo', onRedo)
  })

  it('disables undo/redo while the pane is read-only', () => {
    act(() => {
      useEditorHistory.getState().update({ canUndo: true, canRedo: true })
    })
    renderBar(false)
    expect(screen.getByTestId('editor-undo-btn')).toBeDisabled()
    expect(screen.getByTestId('editor-redo-btn')).toBeDisabled()
  })

  it('toggles read-only mode from the bar and reflects the state in its accessible name and pressed state', () => {
    // Driven by the store, exactly like EditorPane does.
    function StoreDriven() {
      const editable = useUIStore((s) => s.editable)
      return (
        <TooltipProvider>
          <EditorPaneBar editable={editable} />
        </TooltipProvider>
      )
    }
    render(<StoreDriven />)
    const btn = screen.getByTestId('editor-readonly-btn')
    expect(useUIStore.getState().editable).toBe(false)
    // Read-only (default) is the resting state: NOT pressed (Q1 — editable is the active/pressed state).
    expect(btn).toHaveAttribute('aria-pressed', 'false')
    const labelBefore = btn.getAttribute('aria-label')
    fireEvent.click(btn)
    expect(useUIStore.getState().editable).toBe(true)
    // Edit mode is the active/pressed state.
    expect(screen.getByTestId('editor-readonly-btn')).toHaveAttribute('aria-pressed', 'true')
    // The accessible name flips with the mode (read-only offers "edit", edit offers "read-only").
    expect(screen.getByTestId('editor-readonly-btn').getAttribute('aria-label')).not.toBe(
      labelBefore,
    )
  })

  it('labels the find/replace shortcuts with the platform-aware form, not a hardcoded ⌘', () => {
    renderBar(true)
    const findLabel = screen.getByTestId('editor-find-btn').getAttribute('aria-label') ?? ''
    const replaceLabel = screen.getByTestId('editor-replace-btn').getAttribute('aria-label') ?? ''
    expect(findLabel).toContain(formatShortcut('⌘F'))
    expect(replaceLabel).toContain(formatShortcut('⌘H'))
    // Off macOS the Command glyph must not leak into the label — the app's shortcut handler
    // resolves Ctrl off macOS, so the label has to say Ctrl too.
    if (!isMac()) {
      expect(findLabel).not.toContain('⌘')
      expect(replaceLabel).not.toContain('⌘')
    }
  })

  // The accessible name states the ACTION alone; the keyboard shortcut lives in the tooltip (and
  // in the overflow entry, which reuses the same tooltip key). Since ADR-0032 EVERY format action
  // has a shortcut, so every button's name and tooltip differ.
  it('names the bold button by its action alone and carries the shortcut in its tooltip key', async () => {
    renderBar(true)
    expect(screen.getByTestId('fmt-**-**').getAttribute('aria-label')).toBe(t('editor.fmt.bold'))

    // Narrow → the same action moves into the overflow, where the entry text is the tooltip text.
    reportWidth(60)
    fireEvent.pointerDown(screen.getByTestId('editor-overflow-btn'), { button: 0 })
    const item = await screen.findByTestId('fmt-**-**')
    expect(item.textContent).toContain(
      t('editor.fmt.boldShortcut', { shortcut: formatShortcut('⌘B') }),
    )
  })

  // ADR-0032: every format action is keyboard-reachable, so every button must advertise its own
  // glyph — a shortcut nobody can see is a shortcut nobody finds.
  it('names every format button by its action alone', () => {
    renderBar(true)
    const cases: Array<[string, TranslationKey]> = [
      ['fmt-# -', 'editor.fmt.h1'],
      ['fmt-**-**', 'editor.fmt.bold'],
      ['fmt-_-_', 'editor.fmt.italic'],
      ['fmt-`-`', 'editor.fmt.code'],
      ['fmt-[-](url)', 'editor.fmt.link'],
      ['fmt-- -', 'editor.fmt.list'],
      ['fmt-- [ ] -', 'editor.fmt.task'],
    ]
    for (const [testId, labelKey] of cases) {
      expect(screen.getByTestId(testId).getAttribute('aria-label'), testId).toBe(t(labelKey))
    }
  })

  it('advertises the shortcut of every format action in the overflow entry', async () => {
    renderBar(true)
    reportWidth(60)
    fireEvent.pointerDown(screen.getByTestId('editor-overflow-btn'), { button: 0 })
    const cases: Array<[string, TranslationKey, string]> = [
      ['fmt-# -', 'editor.fmt.h1Shortcut', '⌘1'],
      ['fmt-**-**', 'editor.fmt.boldShortcut', '⌘B'],
      ['fmt-_-_', 'editor.fmt.italicShortcut', '⌘I'],
      ['fmt-`-`', 'editor.fmt.codeShortcut', '⌘E'],
      ['fmt-[-](url)', 'editor.fmt.linkShortcut', '⌘K'],
      ['fmt-- -', 'editor.fmt.listShortcut', '⌘⇧L'],
      ['fmt-- [ ] -', 'editor.fmt.taskShortcut', '⌘⇧T'],
    ]
    for (const [testId, tipKey, glyph] of cases) {
      const item = await screen.findByTestId(testId)
      expect(item.textContent, testId).toContain(t(tipKey, { shortcut: formatShortcut(glyph) }))
      // Off macOS the Command glyph must not leak — the handler resolves Ctrl there.
      if (!isMac()) {
        expect(item.textContent, testId).not.toContain('⌘')
      }
    }
  })

  // The shortcut glyph must be PLATFORM-FORMATTED, like every other shortcut label in the app
  // (find / replace / save …): off macOS the app's key handler resolves Ctrl, so a hard-coded
  // '⌘B' would advertise a Command key to Windows / Linux users.
  it('formats the bold shortcut for the platform instead of hard-coding the Command glyph', async () => {
    renderBar(true)
    reportWidth(60)
    fireEvent.pointerDown(screen.getByTestId('editor-overflow-btn'), { button: 0 })
    const item = await screen.findByTestId('fmt-**-**')
    expect(item.textContent).toContain(formatShortcut('⌘B'))
    if (!isMac()) {
      expect(item.textContent).not.toContain('⌘')
    }
  })

  // In the overflow the read-only entry is a MENU ITEM, so it states the ACTION (the toggle is a
  // menu item, not a toggle button — `aria-pressed` is not valid on `menuitem`). The pressed state
  // of the wide bar's toggle is asserted in the tests above.
  it('shows the read-only action in the overflow entry', async () => {
    renderBar(false) // read-only → the action offered is "switch to edit"
    reportWidth(60)
    fireEvent.pointerDown(screen.getByTestId('editor-overflow-btn'), { button: 0 })
    const item = await screen.findByTestId('editor-readonly-btn')
    expect(item.textContent).toContain(t('editor.switchEdit'))
  })

  it('folds every action into a single "…" overflow when the column is narrow', async () => {
    const onInsert = vi.fn()
    document.addEventListener('markdown:insert', onInsert)
    renderBar(true)
    // The bar reports a narrow column (the split ratio is user-draggable down to 0.2).
    reportWidth(60)
    // One overflow button replaces ALL inline actions (Q3: single overflow, no separate Format dropdown).
    expect(screen.getByTestId('editor-overflow-btn')).toBeInTheDocument()
    expect(screen.getByTestId('editor-overflow-btn')).toHaveAttribute(
      'aria-label',
      t('editor.more'),
    )
    expect(screen.getByTestId('editor-overflow-btn')).toHaveAttribute('data-overflow-trigger')
    expect(screen.queryByTestId('fmt-**-**')).toBeNull()
    expect(screen.queryByTestId('editor-find-btn')).toBeNull()

    fireEvent.pointerDown(screen.getByTestId('editor-overflow-btn'), { button: 0 })
    const item = await screen.findByTestId('fmt-**-**')
    fireEvent.click(item)
    expect(onInsert).toHaveBeenCalledTimes(1)
    expect((onInsert.mock.calls[0][0] as CustomEvent).detail).toEqual({
      before: '**',
      after: '**',
    })
    document.removeEventListener('markdown:insert', onInsert)
  })

  it('expands all actions inline again when the column gets wide', () => {
    renderBar(true)
    reportWidth(60)
    expect(screen.getByTestId('editor-overflow-btn')).toBeInTheDocument()
    reportWidth(900)
    expect(screen.queryByTestId('editor-overflow-btn')).toBeNull()
    expect(screen.getByTestId('fmt-**-**')).toBeInTheDocument()
    expect(screen.getByTestId('editor-find-btn')).toBeInTheDocument()
  })

  it('folds undo/redo/read-only/find/replace into the same "…" overflow when very narrow', async () => {
    const onUndo = vi.fn()
    document.addEventListener('markdown:undo', onUndo)
    act(() => {
      useEditorHistory.getState().update({ canUndo: true, canRedo: false })
    })
    renderBar(true)
    // At the narrowest column EVERYTHING has moved into one overflow.
    reportWidth(60)

    // The overflow trigger replaces every inline action.
    expect(screen.getByTestId('editor-overflow-btn')).toBeInTheDocument()
    expect(screen.queryByTestId('editor-undo-btn')).toBeNull()
    expect(screen.queryByTestId('editor-readonly-btn')).toBeNull()
    expect(screen.queryByTestId('editor-find-btn')).toBeNull()
    expect(screen.queryByTestId('editor-replace-btn')).toBeNull()
    expect(screen.queryByTestId('fmt-**-**')).toBeNull()

    // The overflow carries the SAME actions, with the same testids, and they still work.
    fireEvent.pointerDown(screen.getByTestId('editor-overflow-btn'), { button: 0 })
    const undoItem = await screen.findByTestId('editor-undo-btn')
    fireEvent.click(undoItem)
    expect(onUndo).toHaveBeenCalledTimes(1)
    document.removeEventListener('markdown:undo', onUndo)
  })

  it('treats ALL_INLINE_AT as the inclusive lower bound of the fully expanded range', () => {
    renderBar(true)
    // At exactly ALL_INLINE_AT every command fits inline (no "…" trigger); one pixel under it
    // only the lowest-priority commands start moving into the overflow. The e2e environment
    // guard derives its wide / standard contract from the same constant.
    reportWidth(ALL_INLINE_AT)
    expect(screen.queryByTestId('editor-overflow-btn')).toBeNull()
    expect(screen.getByTestId('fmt-**-**')).toBeInTheDocument()
    reportWidth(ALL_INLINE_AT - 1)
    expect(screen.getByTestId('editor-overflow-btn')).toBeInTheDocument()
    expect(screen.getByTestId('fmt-# -')).toBeInTheDocument()
  })

  it('renders the pane bar on the subtle base surface, matching the design image (fig 02 pane bars = #F4F7FB ≈ --color-bg)', () => {
    renderBar(true)
    // The design image uses a SUBTLE tint for the pane (editor/preview) bars (#F4F7FB ≈ --color-bg),
    // distinct from the clearly blue-gray GLOBAL bar (--color-surface-overlay). Assert the pane bar is
    // the base surface — not the white panel, and not the overlay global-bar tint.
    expect(screen.getByTestId('editor-pane-bar')).toHaveClass(/bg-\[var\(--color-bg\)\]/)
    expect(screen.getByTestId('editor-pane-bar')).not.toHaveClass(/surface-overlay/)
  })

  it('renders toolbar icons as contained white tiles with a subtle border (design fig 02/04)', () => {
    renderBar(true)
    const btn = screen.getByTestId('editor-find-btn')
    // Rest state: white tile (--color-surface) + subtle cool-blue border. The blue-gray overlay is
    // only a HOVER variant (`hover:bg-...`), never the rest background.
    expect(btn).toHaveClass(/bg-\[var\(--color-surface\)\]/)
    expect(btn).toHaveClass(/border-\[var\(--color-border\)\]/)
    expect(btn).not.toHaveClass('bg-[var(--color-surface-overlay)]')
  })

  it('shows the read-only toggle as an unpressed tile when read-only', () => {
    renderBar(false) // editable=false → read-only, resting (NOT pressed)
    const btn = screen.getByTestId('editor-readonly-btn')
    expect(btn).not.toHaveAttribute('aria-pressed', 'true')
    expect(btn).toHaveClass(/bg-\[var\(--color-surface\)\]/)
    expect(btn).toHaveClass(/border-\[var\(--color-border\)\]/)
  })

  it('moves commands into More one at a time as the column narrows (priority+ overflow)', () => {
    renderBar(true)
    const inlineCounts = new Set<number>()
    for (const width of [900, 470, 440, 410, 380, 350, 320, 290, 260, 230, 200, 160]) {
      reportWidth(width)
      const bar = screen.getByTestId('editor-pane-bar')
      const inline = bar.querySelectorAll('button[data-testid]').length
      const moreTrigger = screen.queryByTestId('editor-overflow-btn') ? 1 : 0
      inlineCounts.add(inline - moreTrigger)
    }
    // A binary wide/narrow switch can only ever produce {12, 0}. A progressive overflow must
    // visit at least one intermediate state where SOME commands are inline and others are not.
    expect([...inlineCounts].some((n) => n > 0 && n < 12)).toBe(true)
  })

  it('shows the read-only toggle in the pressed/active tile state when editable', () => {
    renderBar(true) // editable=true → pressed (Q1)
    const btn = screen.getByTestId('editor-readonly-btn')
    expect(btn).toHaveAttribute('aria-pressed', 'true')
    expect(btn).toHaveClass(/bg-\[var\(--color-accent-muted\)\]/)
    expect(btn).toHaveClass(/border-\[var\(--color-accent\)\]/)
    expect(btn).toHaveClass(/text-accent/)
  })
})
