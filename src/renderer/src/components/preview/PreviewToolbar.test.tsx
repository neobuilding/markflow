import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '../../i18n'
import { PreviewToolbar } from './PreviewToolbar'
import { TooltipProvider } from '../ui/tooltip'

function setup(content: React.ReactNode) {
  const ref = React.createRef<HTMLDivElement>()
  render(
    <TooltipProvider>
      <div className="relative">
        <div ref={ref}>{content}</div>
        <PreviewToolbar containerRef={ref} previewVisible onExport={() => {}} />
      </div>
    </TooltipProvider>,
  )
  return ref
}

describe('PreviewToolbar', () => {
  it('opens the find panel from the search button', () => {
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
    fireEvent.click(screen.getByTestId('preview-find-count-next'))
    expect(screen.getByTestId('preview-find-count')).toHaveTextContent('2 / 2')
    fireEvent.click(screen.getByTestId('preview-find-count-prev'))
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
    fireEvent.click(screen.getByTestId('preview-find-count-prev'))
    expect(screen.getByTestId('preview-find-count')).toHaveTextContent('2 / 2')
  })

  it('shows a no-match state and ignores next when there are no matches', async () => {
    setup(<p>hello</p>)
    fireEvent.click(screen.getByTestId('preview-find-btn'))
    fireEvent.change(screen.getByTestId('preview-find-input'), { target: { value: 'zzz' } })
    await waitFor(() =>
      expect(screen.getByTestId('preview-find-count')).toHaveTextContent('No match'),
    )
    fireEvent.click(screen.getByTestId('preview-find-count-next'))
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

  it('keeps the query when closed so reopening restores it (one interaction model with the editor)', async () => {
    setup(<p>hello world</p>)
    fireEvent.click(screen.getByTestId('preview-find-btn'))
    fireEvent.change(screen.getByTestId('preview-find-input'), { target: { value: 'hello' } })
    await waitFor(() =>
      expect(document.querySelectorAll('mark.preview-find-match')).toHaveLength(1),
    )
    fireEvent.click(screen.getByTestId('preview-find-close'))
    expect(screen.getByTestId('preview-find-btn')).toBeInTheDocument()
    // Reopen: the previous query is still in the box, matching the editor find widget.
    fireEvent.click(screen.getByTestId('preview-find-btn'))
    expect((screen.getByTestId('preview-find-input') as HTMLInputElement).value).toBe('hello')
    // ...and the HIGHLIGHTS come back with it. Closing clears the marks but keeps the query, so a
    // reopen that only restored the text would leave a stale "No match" counter beside a query that
    // plainly has hits. Asserting the text alone was how this bug slipped through.
    await waitFor(() =>
      expect(document.querySelectorAll('mark.preview-find-match')).toHaveLength(1),
    )
    await waitFor(() => expect(screen.getByTestId('preview-find-count')).toHaveTextContent('1 / 1'))
  })

  it('does not let a match span a hard line break (<br> renders one inside a single <p>)', async () => {
    setup(
      <p>
        foo
        <br />
        bar
      </p>,
    )
    fireEvent.click(screen.getByTestId('preview-find-btn'))
    // A markdown hard break is a <br> INSIDE one paragraph, so "foobar" must not match across it —
    // the two words are on different rendered lines.
    fireEvent.change(screen.getByTestId('preview-find-input'), { target: { value: 'foobar' } })
    await waitFor(() =>
      expect(screen.getByTestId('preview-find-count')).toHaveTextContent('No match'),
    )
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

  it('opens via the preview:find document event that EditorPane dispatches for Ctrl/Cmd+F', () => {
    setup(<p>hello</p>)
    // Ctrl/Cmd+F cannot be a listener on the container: it is a plain NON-FOCUSABLE <div>, so
    // clicking the preview leaves focus on <body> and a keydown never reaches it — which is why
    // Ctrl+F used to do nothing at all in preview mode. EditorPane listens on window, picks the
    // surface by view mode, and dispatches this document event.
    fireEvent(document, new CustomEvent('preview:find'))
    expect(screen.getByTestId('preview-find-bar')).toBeInTheDocument()
  })

  it('focuses the query input on open, so the shortcut can be followed by typing', () => {
    setup(<p>hello</p>)
    fireEvent(document, new CustomEvent('preview:find'))
    expect(document.activeElement).toBe(screen.getByTestId('preview-find-input'))
  })

  it('stays closed for an unrelated document event', () => {
    setup(<p>hello</p>)
    fireEvent(document, new CustomEvent('markdown:find'))
    expect(screen.queryByTestId('preview-find-bar')).toBeNull()
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

  it('highlights a match split across sibling inline elements (KaTeX emits one span per character)', async () => {
    setup(
      <p>
        E ={' '}
        <span className="katex">
          <span className="katex-html" aria-hidden="true">
            <span className="mord mathnormal">m</span>
            <span className="mord mathnormal">c</span>
          </span>
        </span>
      </p>,
    )
    fireEvent.click(screen.getByTestId('preview-find-btn'))
    fireEvent.change(screen.getByTestId('preview-find-input'), { target: { value: 'mc' } })
    // One MATCH, but two marks: KaTeX renders "mc" as one span per character, so a per-text-node
    // search could never find it. Both halves are wrapped, and the counter counts the match once.
    await waitFor(() =>
      expect(document.querySelectorAll('mark.preview-find-match')).toHaveLength(2),
    )
    expect(screen.getByTestId('preview-find-count')).toHaveTextContent('1 / 1')
    expect(document.querySelector('mark.preview-find-match')?.textContent).toBe('m')
  })

  it('ignores the visually hidden KaTeX MathML copy, so the count only covers visible matches', async () => {
    setup(
      <div>
        <span className="katex">
          <span className="katex-mathml">
            <span>mc</span>
          </span>
          <span className="katex-html" aria-hidden="true">
            <span>m</span>
            <span>c</span>
          </span>
        </span>
        <p>mc</p>
      </div>,
    )
    fireEvent.click(screen.getByTestId('preview-find-btn'))
    fireEvent.change(screen.getByTestId('preview-find-input'), { target: { value: 'mc' } })
    // KaTeX renders each formula twice. The hidden MathML copy must not be searchable: without
    // that filter it produced an invisible match that inflated the counter and that next/prev
    // scrolled to — "1 / 3" pointing at nothing.
    await waitFor(() =>
      expect(document.querySelectorAll('mark.preview-find-match')).toHaveLength(3),
    )
    expect(screen.getByTestId('preview-find-count')).toHaveTextContent('1 / 2')
    expect(document.querySelectorAll('.katex-mathml mark')).toHaveLength(0)
  })

  it('does not let a match span a block boundary', async () => {
    // "end" + "abc": the browser's find does not match across blocks, and neither do we.
    setup(
      <div>
        <p>end</p>
        <p>abc</p>
      </div>,
    )
    fireEvent.click(screen.getByTestId('preview-find-btn'))
    fireEvent.change(screen.getByTestId('preview-find-input'), { target: { value: 'enda' } })
    await waitFor(() =>
      expect(screen.getByTestId('preview-find-count')).toHaveTextContent('No match'),
    )
    expect(document.querySelectorAll('mark.preview-find-match')).toHaveLength(0)
  })

  it('walks past comment nodes without breaking the search', async () => {
    const ref = setup(<p>hello world</p>)
    // A comment is neither a text nor an element node: the walker must skip it instead of
    // treating it as inline content that continues (or ends) the current run.
    ref.current?.appendChild(document.createComment(' not searchable '))
    fireEvent.click(screen.getByTestId('preview-find-btn'))
    fireEvent.change(screen.getByTestId('preview-find-input'), { target: { value: 'hello' } })
    await waitFor(() =>
      expect(document.querySelectorAll('mark.preview-find-match')).toHaveLength(1),
    )
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

  it('re-highlights when the case / whole-word / regexp toggles change', async () => {
    setup(<p>Hello hello</p>)
    fireEvent.click(screen.getByTestId('preview-find-btn'))
    fireEvent.change(screen.getByTestId('preview-find-input'), { target: { value: 'hello' } })
    await waitFor(() =>
      expect(document.querySelectorAll('mark.preview-find-match')).toHaveLength(2),
    )
    // Case-sensitive narrows it to the lower-case occurrence only.
    fireEvent.click(screen.getByTestId('preview-find-toggles-case'))
    await waitFor(() =>
      expect(document.querySelectorAll('mark.preview-find-match')).toHaveLength(1),
    )
    fireEvent.click(screen.getByTestId('preview-find-toggles-word'))
    await waitFor(() =>
      expect(document.querySelectorAll('mark.preview-find-match')).toHaveLength(1),
    )
    fireEvent.click(screen.getByTestId('preview-find-toggles-regex'))
    await waitFor(() =>
      expect(document.querySelectorAll('mark.preview-find-match')).toHaveLength(1),
    )
  })

  it('treats the query as a regular expression when the regexp toggle is on', async () => {
    setup(<p>foo123 bar</p>)
    fireEvent.click(screen.getByTestId('preview-find-btn'))
    // Enable regexp before typing so the pattern is used verbatim (not escaped).
    fireEvent.click(screen.getByTestId('preview-find-toggles-regex'))
    fireEvent.change(screen.getByTestId('preview-find-input'), { target: { value: '\\d+' } })
    await waitFor(() =>
      expect(document.querySelectorAll('mark.preview-find-match')).toHaveLength(1),
    )
  })

  it('reports no match when the preview container is not mounted', () => {
    // A ref that is never attached to an element stays null, exercising the `!container` guard.
    const ref = React.createRef<HTMLDivElement>()
    render(
      <TooltipProvider>
        <PreviewToolbar containerRef={ref} previewVisible onExport={() => {}} />
      </TooltipProvider>,
    )
    fireEvent.click(screen.getByTestId('preview-find-btn'))
    fireEvent.change(screen.getByTestId('preview-find-input'), { target: { value: 'hello' } })
    expect(screen.getByTestId('preview-find-count')).toHaveTextContent('No match')
  })

  it('scrolls the current match into view when stepping', async () => {
    const spy = vi.fn()
    // jsdom does not implement scrollIntoView; stub it so the "scroll if available" branch runs.
    ;(Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = spy
    setup(<p>hello world hello again</p>)
    fireEvent.click(screen.getByTestId('preview-find-btn'))
    fireEvent.change(screen.getByTestId('preview-find-input'), { target: { value: 'hello' } })
    await waitFor(() =>
      expect(document.querySelectorAll('mark.preview-find-match')).toHaveLength(2),
    )
    fireEvent.click(screen.getByTestId('preview-find-count-next'))
    expect(spy).toHaveBeenCalled()
  })

  it('guards against zero-length regexp matches instead of looping forever', async () => {
    setup(<p>abc</p>)
    fireEvent.click(screen.getByTestId('preview-find-btn'))
    fireEvent.click(screen.getByTestId('preview-find-toggles-regex'))
    // 'x*' matches the empty string at every position. Those matches cover no characters, so they
    // cannot be highlighted and must not be counted — a counted-but-invisible match is exactly the
    // defect being fixed for KaTeX. The lastIndex guard is what stops this looping forever: if it
    // were removed this test would time out instead of settling on "No match".
    fireEvent.change(screen.getByTestId('preview-find-input'), { target: { value: 'x*' } })
    await waitFor(() =>
      expect(screen.getByTestId('preview-find-count')).toHaveTextContent('No match'),
    )
    expect(document.querySelectorAll('mark.preview-find-match')).toHaveLength(0)
  })

  it('reports no match for an invalid regular expression instead of throwing', async () => {
    setup(<p>foo</p>)
    fireEvent.click(screen.getByTestId('preview-find-btn'))
    fireEvent.click(screen.getByTestId('preview-find-toggles-regex'))
    fireEvent.change(screen.getByTestId('preview-find-input'), { target: { value: '[' } })
    await waitFor(() =>
      expect(screen.getByTestId('preview-find-count')).toHaveTextContent('No match'),
    )
  })

  it('renders the export button only when the preview is visible and forwards the click', () => {
    const onExport = vi.fn()
    const ref = React.createRef<HTMLDivElement>()
    const { rerender } = render(
      <TooltipProvider>
        <div className="relative">
          <div ref={ref}>
            <p>hello</p>
          </div>
          <PreviewToolbar containerRef={ref} previewVisible onExport={onExport} />
        </div>
      </TooltipProvider>,
    )
    const btn = screen.getByTestId('export-btn')
    expect(btn).toBeInTheDocument()
    fireEvent.click(btn)
    expect(onExport).toHaveBeenCalledTimes(1)
    // When the preview is hidden (edit-only mode), the export button leaves the preview bar; it is
    // re-shown on the global header instead.
    rerender(
      <TooltipProvider>
        <div className="relative">
          <div ref={ref}>
            <p>hello</p>
          </div>
          <PreviewToolbar containerRef={ref} previewVisible={false} onExport={onExport} />
        </div>
      </TooltipProvider>,
    )
    expect(screen.queryByTestId('export-btn')).toBeNull()
  })
})
