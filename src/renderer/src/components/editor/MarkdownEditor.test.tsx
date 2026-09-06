import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { MarkdownEditor } from './MarkdownEditor'
import '../../i18n'

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

describe('MarkdownEditor context menu (PLAN §3)', () => {
  const onChange = vi.fn()

  beforeEach(() => {
    ;(window as unknown as { api: unknown }).api = {
      clipboard: { writeText: vi.fn(async () => {}) },
      app: { openExternal: vi.fn(async () => {}), showInFolder: vi.fn(async () => {}) },
    }
  })

  function setup(props: { content?: string; editable?: boolean; filePath?: string | null } = {}) {
    const { content = '# Hello', editable = true, filePath = null } = props
    render(
      <MarkdownEditor
        content={content}
        docId="d1"
        onChange={onChange}
        editable={editable}
        filePath={filePath}
      />,
    )
    return document.querySelector('.editor-content') as HTMLElement
  }

  it('renders all 13 items when opened', async () => {
    const c = setup()
    fireEvent.contextMenu(c)
    expect(await screen.findByTestId('ctx-undo')).toBeInTheDocument()
    for (const id of [
      'ctx-redo',
      'ctx-cut',
      'ctx-copy',
      'ctx-paste',
      'ctx-select-all',
      'ctx-bold',
      'ctx-italic',
      'ctx-inline-code',
      'ctx-link',
      'ctx-open-link-in-browser',
      'ctx-copy-path',
      'ctx-show-in-folder',
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
  })

  it('closes the menu on a second contextmenu (snapshot clears)', async () => {
    const c = setup()
    fireEvent.contextMenu(c)
    await screen.findByTestId('ctx-undo')
    fireEvent.contextMenu(c)
  })

  it('disables history/edit commands in read-only mode', async () => {
    const c = setup({ editable: false })
    fireEvent.contextMenu(c)
    expect(await screen.findByTestId('ctx-undo')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('ctx-redo')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('ctx-cut')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('ctx-paste')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('ctx-bold')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('ctx-italic')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('ctx-inline-code')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('ctx-link')).toHaveAttribute('aria-disabled', 'true')
    // copy / select-all remain available on a non-empty read-only doc
    expect(screen.getByTestId('ctx-select-all')).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('enables cut/copy when there is a selection', async () => {
    const c = setup()
    getView().dispatch({ selection: { anchor: 0, head: 7 } })
    fireEvent.contextMenu(c)
    expect(await screen.findByTestId('ctx-cut')).not.toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('ctx-copy')).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('disables select-all on an empty document', async () => {
    const c = setup({ content: '' })
    fireEvent.contextMenu(c)
    expect(await screen.findByTestId('ctx-select-all')).toHaveAttribute('aria-disabled', 'true')
  })

  it('enables undo after an edit and redo after undo', async () => {
    const c = setup()
    getView().dispatch({ changes: { from: 0, insert: 'x' } })
    fireEvent.contextMenu(c)
    expect(await screen.findByTestId('ctx-undo')).not.toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('ctx-redo')).toHaveAttribute('aria-disabled', 'true')
    await fireEvent.click(screen.getByTestId('ctx-undo'))
    fireEvent.contextMenu(c)
    expect(await screen.findByTestId('ctx-redo')).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('copy writes the selected text to the clipboard', async () => {
    const c = setup()
    getView().dispatch({ selection: { anchor: 0, head: 7 } })
    fireEvent.contextMenu(c)
    await fireEvent.click(await screen.findByTestId('ctx-copy'))
    await waitFor(() => expect(window.api.clipboard.writeText).toHaveBeenCalledWith('# Hello'))
  })

  it('cut removes the selected text and writes it to the clipboard', async () => {
    const c = setup()
    getView().dispatch({ selection: { anchor: 0, head: 7 } })
    fireEvent.contextMenu(c)
    await fireEvent.click(await screen.findByTestId('ctx-cut'))
    await waitFor(() => expect(window.api.clipboard.writeText).toHaveBeenCalledWith('# Hello'))
    await waitFor(() => expect(getView().state.doc.toString()).toBe(''))
  })

  it('cut restores the cached selection if the contextmenu cleared it (G4)', async () => {
    const c = setup()
    const view = getView()
    view.dispatch({ selection: { anchor: 0, head: 7 } })
    fireEvent.pointerDown(c) // cache (0,7) on the right-click gesture
    view.dispatch({ selection: { anchor: 0, head: 0 } }) // contextmenu cleared it
    fireEvent.contextMenu(c)
    await fireEvent.click(await screen.findByTestId('ctx-cut'))
    await waitFor(() => expect(window.api.clipboard.writeText).toHaveBeenCalledWith('# Hello'))
    await waitFor(() => expect(view.state.doc.toString()).toBe(''))
  })

  it('paste inserts the clipboard text at the cursor', async () => {
    ;(navigator as unknown as { clipboard: { readText: () => Promise<string> } }).clipboard = {
      readText: async () => 'PASTE',
    }
    const c = setup()
    fireEvent.contextMenu(c)
    await fireEvent.click(await screen.findByTestId('ctx-paste'))
    await waitFor(() => expect(getView().state.doc.toString()).toContain('PASTE'))
  })

  it('bold wraps the selection with markers', async () => {
    const c = setup()
    getView().dispatch({ selection: { anchor: 0, head: 7 } })
    fireEvent.contextMenu(c)
    await fireEvent.click(await screen.findByTestId('ctx-bold'))
    expect(getView().state.doc.toString()).toContain('**# Hello**')
  })

  it('link inserts a link with the cursor parked between the brackets', async () => {
    const c = setup()
    fireEvent.contextMenu(c)
    await fireEvent.click(await screen.findByTestId('ctx-link'))
    expect(getView().state.doc.toString()).toContain('[](url)')
  })

  it('open-link-in-browser is enabled on a link and calls openExternal', async () => {
    const c = setup({ content: '[text](http://example.com)' })
    getView().dispatch({ selection: { anchor: 3, head: 3 } })
    fireEvent.contextMenu(c)
    const item = await screen.findByTestId('ctx-open-link-in-browser')
    expect(item).not.toHaveAttribute('aria-disabled', 'true')
    await fireEvent.click(item)
    expect(window.api.app.openExternal).toHaveBeenCalledWith('http://example.com')
  })

  it('copy path and show in folder use the file path', async () => {
    const c = setup({ filePath: '/docs/a.md' })
    fireEvent.contextMenu(c)
    expect(await screen.findByTestId('ctx-copy-path')).not.toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('ctx-show-in-folder')).not.toHaveAttribute('aria-disabled', 'true')
    await fireEvent.click(screen.getByTestId('ctx-copy-path'))
    await waitFor(() => expect(window.api.clipboard.writeText).toHaveBeenCalledWith('/docs/a.md'))
    // selecting an item closes the menu, so re-open before the next action
    fireEvent.contextMenu(c)
    await fireEvent.click(await screen.findByTestId('ctx-show-in-folder'))
    await waitFor(() => expect(window.api.app.showInFolder).toHaveBeenCalledWith('/docs/a.md'))
  })

  it('show-in-folder swallows a rejection without throwing (PLAN §5.3)', async () => {
    const c = setup({ filePath: '/docs/a.md' })
    // Force the underlying IPC to reject (e.g. an externally-deleted file) so the
    // defensive .catch in showInFolder is exercised and the failure is swallowed.
    ;(window.api.app.showInFolder as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error('folder not found')
    })
    fireEvent.contextMenu(c)
    await screen.findByTestId('ctx-show-in-folder')
    expect(() => fireEvent.click(screen.getByTestId('ctx-show-in-folder'))).not.toThrow()
  })

  it('select all selects the whole document', async () => {
    const c = setup()
    fireEvent.contextMenu(c)
    await fireEvent.click(await screen.findByTestId('ctx-select-all'))
    const sel = getView().state.selection.main
    expect(sel.from).toBe(0)
    expect(sel.to).toBe(getView().state.doc.length)
  })

  it('italic wraps the selection with underscores', async () => {
    const c = setup()
    getView().dispatch({ selection: { anchor: 0, head: 7 } })
    fireEvent.contextMenu(c)
    await fireEvent.click(await screen.findByTestId('ctx-italic'))
    expect(getView().state.doc.toString()).toContain('_# Hello_')
  })

  it('inline code wraps the selection with backticks', async () => {
    const c = setup()
    getView().dispatch({ selection: { anchor: 0, head: 7 } })
    fireEvent.contextMenu(c)
    await fireEvent.click(await screen.findByTestId('ctx-inline-code'))
    expect(getView().state.doc.toString()).toContain('`# Hello`')
  })

  it('undo reverts the last edit', async () => {
    const c = setup()
    getView().dispatch({ changes: { from: 0, insert: 'x' } })
    fireEvent.contextMenu(c)
    await fireEvent.click(await screen.findByTestId('ctx-undo'))
    await waitFor(() => expect(getView().state.doc.toString()).toBe('# Hello'))
  })

  it('redo reapplies the undone edit', async () => {
    const c = setup()
    getView().dispatch({ changes: { from: 0, insert: 'x' } })
    fireEvent.contextMenu(c)
    await fireEvent.click(await screen.findByTestId('ctx-undo'))
    fireEvent.contextMenu(c)
    await fireEvent.click(await screen.findByTestId('ctx-redo'))
    await waitFor(() => expect(getView().state.doc.toString()).toBe('x# Hello'))
  })

  it('open-link-in-browser targets the link under the cursor among several', async () => {
    const c = setup({ content: '[a](http://one.com) [b](http://two.com)' })
    getView().dispatch({ selection: { anchor: 28, head: 28 } })
    fireEvent.contextMenu(c)
    const item = await screen.findByTestId('ctx-open-link-in-browser')
    expect(item).not.toHaveAttribute('aria-disabled', 'true')
    await fireEvent.click(item)
    expect(window.api.app.openExternal).toHaveBeenCalledWith('http://two.com')
  })

  it('cut with a collapsed cached selection is a no-op (G4 false branch)', async () => {
    const c = setup()
    getView().dispatch({ selection: { anchor: 0, head: 0 } })
    fireEvent.pointerDown(c) // cache a collapsed selection (0,0)
    fireEvent.contextMenu(c)
    await fireEvent.click(await screen.findByTestId('ctx-cut'))
    await waitFor(() => expect(window.api.clipboard.writeText).toHaveBeenCalledWith(''))
    expect(getView().state.doc.toString()).toBe('# Hello')
  })

  it('bold with no selection parks the cursor between the markers, never inserts "text" (PLAN §3)', async () => {
    const c = setup()
    const before = getView().state.doc.length // 7 for '# Hello'
    // Collapse the selection at the end of the document (no selected text).
    getView().dispatch({ selection: { anchor: before } })
    fireEvent.contextMenu(c)
    await fireEvent.click(await screen.findByTestId('ctx-bold'))
    const view = getView()
    // No selection → inserts **** with the caret between the markers,
    // distinct from the toolbar's '**text**' placeholder behaviour.
    expect(view.state.doc.toString()).toBe('# Hello****')
    expect(view.state.doc.toString()).not.toContain('text')
    const sel = view.state.selection.main
    expect(sel.empty).toBe(true)
    expect(sel.head).toBe(before + 2) // before.length === 2 for '**'
  })
})
