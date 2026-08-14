import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
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
})
