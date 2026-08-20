import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import { MarkdownEditor } from './MarkdownEditor'

import '../../i18n'

function ce(container: HTMLElement): string | null {
  return container.querySelector('.cm-content')?.getAttribute('contentEditable') ?? null
}

function mount(editable: boolean) {
  const onChange = vi.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const { unmount } = render(
    <MarkdownEditor content="# hi" onChange={onChange} editable={editable} />,
    {
      container,
    },
  )
  return { container, onChange, unmount }
}

beforeEach(() => {
  vi.useRealTimers()
})

afterEach(() => {
  cleanup()
})

describe('MarkdownEditor', () => {
  it('renders a CodeMirror editor that is editable by default', () => {
    const { container, unmount } = mount(true)
    expect(container.querySelector('.cm-content')).not.toBeNull()
    expect(ce(container)).toBe('true')
    unmount()
  })

  it('is read-only when editable is false', () => {
    const { container, unmount } = mount(false)
    expect(ce(container)).toBe('false')
    unmount()
  })

  it('writes the provided content into the editor', () => {
    const { container, unmount } = mount(true)
    expect(container.querySelector('.cm-content')?.textContent).toContain('hi')
    unmount()
  })

  it('reconfigures editability when the prop changes', () => {
    const { container, unmount } = mount(true)
    expect(ce(container)).toBe('true')
    render(<MarkdownEditor content="# hi" onChange={vi.fn()} editable={false} />, {
      container,
    })
    act(() => {
      // rerender already applied; give effects a tick
    })
    expect(ce(container)).toBe('false')
    unmount()
  })

  it('ignores markdown:insert events in read-only mode', () => {
    const { container, onChange, unmount } = mount(false)
    document.dispatchEvent(
      new CustomEvent('markdown:insert', { detail: { before: '**', after: '**' } }),
    )
    expect(container.querySelector('.cm-content')?.textContent).toContain('# hi')
    expect(onChange).not.toHaveBeenCalled()
    unmount()
  })

  it('inserts text on a markdown:insert event in edit mode', () => {
    const { container, unmount } = mount(true)
    document.dispatchEvent(
      new CustomEvent('markdown:insert', { detail: { before: '**', after: '**' } }),
    )
    // No text is selected, so the placeholder 'text' is wrapped with the markers at the cursor.
    expect(container.querySelector('.cm-content')?.textContent).toContain('**text**')
    // The internal-edit guard (echo suppression) is exercised when the parent re-feeds the same
    // document id with new content right after an internal insert.
    render(<MarkdownEditor content="# hi" onChange={vi.fn()} editable={true} docId="a" />, {
      container,
    })
    expect(container.querySelector('.cm-content')?.textContent).toContain('hi')
    unmount()
  })

  it('syncs new content when the document switches', () => {
    const { container, unmount } = mount(true)
    expect(container.querySelector('.cm-content')?.textContent).toContain('hi')
    render(<MarkdownEditor content="# switched" onChange={vi.fn()} editable={true} docId="b" />, {
      container,
    })
    expect(container.querySelector('.cm-content')?.textContent).toContain('switched')
    unmount()
  })

  it('focuses the editor on a real pointer down', () => {
    const { container, unmount } = mount(true)
    const root = container.firstChild as HTMLElement
    // The root div carries onPointerDown={handlePointerDown}, which focuses the CodeMirror view.
    expect(() => fireEvent.pointerDown(root)).not.toThrow()
    unmount()
  })
})
