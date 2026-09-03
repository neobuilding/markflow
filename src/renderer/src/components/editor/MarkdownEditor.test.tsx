import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { MarkdownEditor } from './MarkdownEditor'

beforeEach(() => {
  cleanup()
})

function getView(): EditorView {
  const el = document.querySelector('.cm-editor') as HTMLElement
  const view = EditorView.findFromDOM(el)
  if (!view) throw new Error('EditorView not found')
  return view
}

describe('MarkdownEditor', () => {
  it('renders the given content', () => {
    render(<MarkdownEditor content="# Hello" docId="d1" onChange={() => {}} />)
    expect(screen.getByText('# Hello')).toBeTruthy()
  })

  it('skips re-applying an internal (echo) change on the same document', async () => {
    const onChange = vi.fn()
    const { rerender } = render(<MarkdownEditor content="a" docId="d1" onChange={onChange} />)

    // Simulate a user keystroke by dispatching through the real EditorView.
    // This fires the updateListener, which marks the change as internal.
    const view = getView()
    view.dispatch(view.state.replaceSelection('b'))
    await waitFor(() => expect(onChange).toHaveBeenCalled())

    const callsAfterType = onChange.mock.calls.length

    // The parent echoes the new content back (same document, same id) — the
    // effect must NOT re-apply it (isInternalChange && !isDocSwitch), so the
    // editor keeps the user's text and no extra onChange fires.
    rerender(<MarkdownEditor content="ba" docId="d1" onChange={onChange} />)

    await waitFor(() => {
      expect(getView().state.doc.toString()).toBe('ba')
    })
    expect(onChange.mock.calls.length).toBe(callsAfterType)
  })

  it('inserts text from a markdown:insert toolbar event', async () => {
    const onChange = vi.fn()
    render(<MarkdownEditor content="hi" docId="d1" onChange={onChange} />)
    const view = getView()
    // Select the whole document, then fire a bold insert (**...**).
    view.dispatch({ selection: { anchor: 0, head: 2 } })
    document.dispatchEvent(
      new CustomEvent('markdown:insert', { detail: { before: '**', after: '**' } }),
    )
    await waitFor(() => expect(view.state.doc.toString()).toBe('**hi**'))
  })

  it('inserts the placeholder when there is no selection', async () => {
    const onChange = vi.fn()
    render(<MarkdownEditor content="hi" docId="d1" onChange={onChange} />)
    const view = getView()
    // Collapse the selection (no selected text) before firing the insert.
    view.dispatch({ selection: { anchor: 1, head: 1 } })
    document.dispatchEvent(
      new CustomEvent('markdown:insert', { detail: { before: '**', after: '**' } }),
    )
    // selectedText is empty → the placeholder 'text' is wrapped: **text** at the caret.
    await waitFor(() => expect(view.state.doc.toString()).toBe('h**text**i'))
  })

  it('focuses the editor on a real pointerdown gesture', () => {
    const onChange = vi.fn()
    render(<MarkdownEditor content="hi" docId="d1" onChange={onChange} />)
    const div = document.querySelector('.editor-content') as HTMLElement
    // Must not throw; the handler focuses the underlying CodeMirror view.
    expect(() => fireEvent.pointerDown(div)).not.toThrow()
  })
})
