import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '../../i18n'
import { PreviewFindBar } from './PreviewFindBar'

function setup(content: React.ReactNode) {
  const ref = React.createRef<HTMLDivElement>()
  render(
    <div className="relative">
      <div ref={ref}>{content}</div>
      <PreviewFindBar containerRef={ref} />
    </div>,
  )
  return ref
}

describe('PreviewFindBar', () => {
  it('opens the find bar from the search button', () => {
    setup(<p>hello</p>)
    fireEvent.click(screen.getByTestId('preview-find-btn'))
    expect(screen.getByTestId('preview-find-bar')).toBeInTheDocument()
  })

  it('highlights every match and shows the 1 / N count', async () => {
    setup(<p>hello world hello again</p>)
    fireEvent.click(screen.getByTestId('preview-find-btn'))
    fireEvent.change(screen.getByTestId('preview-find-input'), { target: { value: 'hello' } })
    await waitFor(() =>
      expect(document.querySelectorAll('mark.preview-find-match')).toHaveLength(2),
    )
    // `count` updates on the setIndex re-render, so await it too.
    await waitFor(() => expect(screen.getByTestId('preview-find-count')).toHaveTextContent('1 / 2'))
  })

  it('navigates between matches with next/prev', async () => {
    setup(<p>hello world hello again</p>)
    fireEvent.click(screen.getByTestId('preview-find-btn'))
    fireEvent.change(screen.getByTestId('preview-find-input'), { target: { value: 'hello' } })
    await waitFor(() =>
      expect(document.querySelectorAll('mark.preview-find-match')).toHaveLength(2),
    )
    fireEvent.click(screen.getByTestId('preview-find-next'))
    expect(screen.getByTestId('preview-find-count')).toHaveTextContent('2 / 2')
    fireEvent.click(screen.getByTestId('preview-find-prev'))
    expect(screen.getByTestId('preview-find-count')).toHaveTextContent('1 / 2')
  })

  it('wraps around when navigating past the ends', async () => {
    setup(<p>hello world hello again</p>)
    fireEvent.click(screen.getByTestId('preview-find-btn'))
    fireEvent.change(screen.getByTestId('preview-find-input'), { target: { value: 'hello' } })
    await waitFor(() =>
      expect(document.querySelectorAll('mark.preview-find-match')).toHaveLength(2),
    )
    // from index 0, prev wraps to the last match
    fireEvent.click(screen.getByTestId('preview-find-prev'))
    expect(screen.getByTestId('preview-find-count')).toHaveTextContent('2 / 2')
  })

  it('shows a no-match state and ignores next when there are no matches', async () => {
    setup(<p>hello</p>)
    fireEvent.click(screen.getByTestId('preview-find-btn'))
    fireEvent.change(screen.getByTestId('preview-find-input'), { target: { value: 'zzz' } })
    await waitFor(() =>
      expect(screen.getByTestId('preview-find-count')).toHaveTextContent('No match'),
    )
    fireEvent.click(screen.getByTestId('preview-find-next'))
    expect(screen.getByTestId('preview-find-count')).toHaveTextContent('No match')
  })

  it('closes via the close button and clears highlights', async () => {
    setup(<p>hello world hello again</p>)
    fireEvent.click(screen.getByTestId('preview-find-btn'))
    fireEvent.change(screen.getByTestId('preview-find-input'), { target: { value: 'hello' } })
    await waitFor(() =>
      expect(document.querySelectorAll('mark.preview-find-match')).toHaveLength(2),
    )
    fireEvent.click(screen.getByTestId('preview-find-close'))
    expect(screen.getByTestId('preview-find-btn')).toBeInTheDocument()
    expect(document.querySelectorAll('mark.preview-find-match')).toHaveLength(0)
  })

  it('closes via Escape', async () => {
    setup(<p>hello</p>)
    fireEvent.click(screen.getByTestId('preview-find-btn'))
    fireEvent.change(screen.getByTestId('preview-find-input'), { target: { value: 'hello' } })
    await waitFor(() =>
      expect(document.querySelectorAll('mark.preview-find-match')).toHaveLength(1),
    )
    fireEvent.keyDown(screen.getByTestId('preview-find-input'), { key: 'Escape' })
    expect(screen.getByTestId('preview-find-btn')).toBeInTheDocument()
  })

  it('navigates via Enter / Shift+Enter in the input', async () => {
    setup(<p>hello world hello again</p>)
    fireEvent.click(screen.getByTestId('preview-find-btn'))
    const input = screen.getByTestId('preview-find-input')
    fireEvent.change(input, { target: { value: 'hello' } })
    await waitFor(() =>
      expect(document.querySelectorAll('mark.preview-find-match')).toHaveLength(2),
    )
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByTestId('preview-find-count')).toHaveTextContent('2 / 2')
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(screen.getByTestId('preview-find-count')).toHaveTextContent('1 / 2')
  })

  it('opens via Ctrl+F on the preview container', () => {
    const ref = setup(<p>hello</p>)
    fireEvent.keyDown(ref.current as HTMLElement, { key: 'f', ctrlKey: true })
    expect(screen.getByTestId('preview-find-bar')).toBeInTheDocument()
  })

  it('ignores text inside script/style elements', async () => {
    setup(
      <div>
        <p>hello</p>
        <style>{'hello{}'}</style>
        <script>{'hello'}</script>
      </div>,
    )
    fireEvent.click(screen.getByTestId('preview-find-btn'))
    fireEvent.change(screen.getByTestId('preview-find-input'), { target: { value: 'hello' } })
    await waitFor(() =>
      expect(document.querySelectorAll('mark.preview-find-match')).toHaveLength(1),
    )
  })

  it('opens via Cmd+F (metaKey) on the preview container', () => {
    const ref = setup(<p>hello</p>)
    fireEvent.keyDown(ref.current as HTMLElement, { key: 'f', metaKey: true })
    expect(screen.getByTestId('preview-find-bar')).toBeInTheDocument()
  })

  it('ignores a plain keydown (no ctrl/meta) on the preview container', () => {
    const ref = setup(<p>hello</p>)
    fireEvent.keyDown(ref.current as HTMLElement, { key: 'a' })
    expect(screen.queryByTestId('preview-find-bar')).toBeNull()
  })

  it('ignores Ctrl+non-F on the preview container', () => {
    const ref = setup(<p>hello</p>)
    fireEvent.keyDown(ref.current as HTMLElement, { key: 'g', ctrlKey: true })
    expect(screen.queryByTestId('preview-find-bar')).toBeNull()
  })

  it('ignores a non-Escape/non-Enter key in the find input', async () => {
    setup(<p>hello</p>)
    fireEvent.click(screen.getByTestId('preview-find-btn'))
    fireEvent.change(screen.getByTestId('preview-find-input'), { target: { value: 'hello' } })
    await waitFor(() =>
      expect(document.querySelectorAll('mark.preview-find-match')).toHaveLength(1),
    )
    // A key that is neither Escape nor Enter must reach the implicit else of onKeyDown.
    fireEvent.keyDown(screen.getByTestId('preview-find-input'), { key: 'a' })
    expect(screen.getByTestId('preview-find-count')).toHaveTextContent('1 / 1')
  })

  it('skips whitespace-only text nodes without highlighting them', async () => {
    // `{'   '}` renders a whitespace-only text node ahead of the element, exercising the
    // TreeWalker's reject-when-blank branch.
    setup(
      <p>
        {'   '}
        <em>hello</em>
      </p>,
    )
    fireEvent.click(screen.getByTestId('preview-find-btn'))
    fireEvent.change(screen.getByTestId('preview-find-input'), { target: { value: 'hello' } })
    await waitFor(() =>
      expect(document.querySelectorAll('mark.preview-find-match')).toHaveLength(1),
    )
  })
})
