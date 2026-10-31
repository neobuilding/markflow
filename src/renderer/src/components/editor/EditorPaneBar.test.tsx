import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import '../../i18n'
import { EditorPaneBar } from './EditorPaneBar'
import { TooltipProvider } from '../ui/tooltip'
import { useUIStore } from '../../store/ui'
import { useEditorHistory } from '../../store/editorHistory'
import { formatShortcut, isMac } from '../../lib/utils'

// A controllable ResizeObserver: the bar folds its format cluster by COLUMN width (ADR-0024 §10
// trade-off 54), so the test has to be able to report a width. The global polyfill in
// test-setup.ts is a no-op (jsdom has no layout), which would leave the collapse path untested.
//
// Every constructed observer is collected, not just the last one: Radix's Popper (used by the
// Format dropdown) also constructs a ResizeObserver, so keeping only the newest callback would
// hand the test someone else's observer.
type ResizeCallback = (entries: Array<{ contentRect: { width: number } }>) => void
const observers: ResizeCallback[] = []

class MockResizeObserver {
  constructor(cb: ResizeCallback) {
    observers.push(cb)
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// Report a width to every live observer.
function reportWidth(width: number) {
  act(() => {
    observers.forEach((cb) => cb([{ contentRect: { width } }]))
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
    // The collapsed trigger is absent while the column is wide enough.
    expect(screen.queryByTestId('fmt-dropdown-btn')).toBeNull()
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

  it('toggles read-only mode from the bar and reflects the state in its accessible name', () => {
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
    const labelBefore = btn.getAttribute('aria-label')
    fireEvent.click(btn)
    expect(useUIStore.getState().editable).toBe(true)
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

  it('folds the format cluster into a Format dropdown when the column is narrow', async () => {
    const onInsert = vi.fn()
    document.addEventListener('markdown:insert', onInsert)
    renderBar(true)
    // The bar reports a narrow column (the split ratio is user-draggable down to 0.2).
    reportWidth(300)
    expect(screen.getByTestId('fmt-dropdown-btn')).toBeInTheDocument()
    // The expanded buttons are gone — the actions moved one level deeper.
    expect(screen.queryByTestId('fmt-**-**')).toBeNull()

    fireEvent.pointerDown(screen.getByTestId('fmt-dropdown-btn'), { button: 0 })
    const item = await screen.findByTestId('fmt-**-**')
    fireEvent.click(item)
    expect(onInsert).toHaveBeenCalledTimes(1)
    expect((onInsert.mock.calls[0][0] as CustomEvent).detail).toEqual({
      before: '**',
      after: '**',
    })
    document.removeEventListener('markdown:insert', onInsert)
  })

  it('expands the format cluster again when the column gets wide', () => {
    renderBar(true)
    reportWidth(300)
    expect(screen.getByTestId('fmt-dropdown-btn')).toBeInTheDocument()
    reportWidth(900)
    expect(screen.queryByTestId('fmt-dropdown-btn')).toBeNull()
    expect(screen.getByTestId('fmt-**-**')).toBeInTheDocument()
  })

  it('folds undo/redo/read-only into a `…` overflow when the column is very narrow', async () => {
    const onUndo = vi.fn()
    document.addEventListener('markdown:undo', onUndo)
    act(() => {
      useEditorHistory.getState().update({ canUndo: true, canRedo: false })
    })
    renderBar(true)
    // Below the 4-item budget even the folded bar does not fit.
    reportWidth(200)

    // The overflow trigger replaces the three inline actions.
    expect(screen.getByTestId('editor-overflow-btn')).toBeInTheDocument()
    expect(screen.queryByTestId('editor-undo-btn')).toBeNull()
    expect(screen.queryByTestId('editor-readonly-btn')).toBeNull()
    // The format cluster is folded too, while find / replace stay inline (they are the primary
    // entry points and must never be more than one level deep).
    expect(screen.getByTestId('fmt-dropdown-btn')).toBeInTheDocument()
    expect(screen.getByTestId('editor-find-btn')).toBeInTheDocument()
    expect(screen.getByTestId('editor-replace-btn')).toBeInTheDocument()

    // The overflow carries the SAME actions, with the same testids, and they still work.
    fireEvent.pointerDown(screen.getByTestId('editor-overflow-btn'), { button: 0 })
    const undoItem = await screen.findByTestId('editor-undo-btn')
    fireEvent.click(undoItem)
    expect(onUndo).toHaveBeenCalledTimes(1)
    document.removeEventListener('markdown:undo', onUndo)
  })
})
