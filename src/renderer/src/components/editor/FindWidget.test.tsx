import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '../../i18n'
import { FindWidget } from './FindWidget'
import type { FindToggleState } from '../../lib/find-toggles'

const toggleState: FindToggleState = {
  caseSensitive: false,
  wholeWord: false,
  regexp: false,
  preserveCase: false,
}

function setup(props: Partial<React.ComponentProps<typeof FindWidget>> = {}) {
  const handlers = {
    onQueryChange: vi.fn(),
    onPrev: vi.fn(),
    onNext: vi.fn(),
    onClose: vi.fn(),
    onToggle: vi.fn(),
    onReplaceTextChange: vi.fn(),
    onReplaceNext: vi.fn(),
    onReplaceAll: vi.fn(),
  }
  render(
    <FindWidget
      testId="editor-find"
      query=""
      onQueryChange={handlers.onQueryChange}
      total={2}
      current={1}
      onPrev={handlers.onPrev}
      onNext={handlers.onNext}
      onClose={handlers.onClose}
      toggleState={toggleState}
      onToggle={handlers.onToggle}
      showReplace={false}
      onReplaceTextChange={handlers.onReplaceTextChange}
      onReplaceNext={handlers.onReplaceNext}
      onReplaceAll={handlers.onReplaceAll}
      {...props}
    />,
  )
  return handlers
}

describe('FindWidget', () => {
  it('renders the query input and the case/word/regex toggles (no AB without replace)', () => {
    setup()
    expect(screen.getByTestId('editor-find-input')).toBeInTheDocument()
    expect(screen.getByTestId('editor-find-toggles-case')).toBeInTheDocument()
    expect(screen.getByTestId('editor-find-toggles-word')).toBeInTheDocument()
    expect(screen.getByTestId('editor-find-toggles-regex')).toBeInTheDocument()
    expect(screen.queryByTestId('editor-find-toggles-preserve')).toBeNull()
  })

  it('shows the AB (preserve case) toggle only when replace is shown', () => {
    setup({ showReplace: true })
    expect(screen.getByTestId('editor-find-toggles-preserve')).toBeInTheDocument()
  })

  it('fires onToggle with the toggle key', () => {
    const h = setup()
    fireEvent.click(screen.getByTestId('editor-find-toggles-case'))
    expect(h.onToggle).toHaveBeenCalledWith('case')
  })

  it('shows the k / n counter', () => {
    setup()
    expect(screen.getByTestId('editor-find-count-count').textContent).toBe('1 / 2')
  })

  it('fires prev / next / close', () => {
    const h = setup()
    fireEvent.click(screen.getByTestId('editor-find-count-prev'))
    fireEvent.click(screen.getByTestId('editor-find-count-next'))
    fireEvent.click(screen.getByTestId('editor-find-close'))
    expect(h.onPrev).toHaveBeenCalledTimes(1)
    expect(h.onNext).toHaveBeenCalledTimes(1)
    expect(h.onClose).toHaveBeenCalledTimes(1)
  })

  it('Enter advances, Shift+Enter goes back, Esc closes, F3 advances', () => {
    const h = setup()
    const input = screen.getByTestId('editor-find-input')
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.keyDown(input, { key: 'F3' })
    fireEvent.keyDown(input, { key: 'F3', shiftKey: true })
    expect(h.onNext).toHaveBeenCalledTimes(2)
    expect(h.onPrev).toHaveBeenCalledTimes(2)
    expect(h.onClose).toHaveBeenCalledTimes(1)
  })

  it('shows the replace row only when showReplace and fires replace callbacks', () => {
    const h = setup({ showReplace: true })
    const replaceInput = screen.getByTestId('editor-find-replace') as HTMLInputElement
    fireEvent.change(replaceInput, { target: { value: 'x' } })
    expect(h.onReplaceTextChange).toHaveBeenCalledWith('x')
    fireEvent.click(screen.getByTestId('editor-find-replace-btn'))
    fireEvent.click(screen.getByTestId('editor-find-replace-all'))
    expect(h.onReplaceNext).toHaveBeenCalledTimes(1)
    expect(h.onReplaceAll).toHaveBeenCalledTimes(1)
  })

  it('hides the replace row by default', () => {
    setup()
    expect(screen.queryByTestId('editor-find-replace')).toBeNull()
  })

  it('falls back to hiding the replace row when showReplace is omitted entirely', () => {
    // Rendered directly (bypassing `setup`, which always passes showReplace) so the
    // `showReplace = false` destructuring default is genuinely exercised.
    render(
      <FindWidget
        testId="editor-find"
        query=""
        onQueryChange={() => {}}
        total={0}
        current={0}
        onPrev={() => {}}
        onNext={() => {}}
        onClose={() => {}}
        toggleState={toggleState}
        onToggle={() => {}}
      />,
    )
    expect(screen.queryByTestId('editor-find-replace')).toBeNull()
  })

  it('steps through matches with Ctrl/Cmd+G, and backwards with Shift', () => {
    const h = setup()
    const input = screen.getByTestId('editor-find-input')
    fireEvent.keyDown(input, { key: 'g', ctrlKey: true })
    expect(h.onNext).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(input, { key: 'G', ctrlKey: true, shiftKey: true })
    expect(h.onPrev).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(input, { key: 'g', metaKey: true })
    expect(h.onNext).toHaveBeenCalledTimes(2)
  })

  it('clears the query through the input clear button', () => {
    const h = setup({ query: 'foo' })
    fireEvent.click(screen.getByTestId('editor-find-input-clear'))
    expect(h.onQueryChange).toHaveBeenCalledWith('')
  })
})
