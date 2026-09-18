import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  resolveSelectAllTarget,
  routeSelectAll,
  createSelectAllKeydownHandler,
} from './selectAllRouter'

// The pure classifier is the load-bearing logic: it decides which surface a Ctrl+A
// (routed from the native menu's menu:select-all IPC) applies to. The bug it prevents:
// the old `{ role: 'selectAll' }` ran a NATIVE webContents-wide select-all, which ignored
// CodeMirror and swept both panes when the caret sat in the preview.

describe('resolveSelectAllTarget', () => {
  // Minimal element stand-ins: `closest` always misses unless stubbed; the article's
  // `contains` is controlled per-test.
  function fakeEl(): Element {
    return { closest: () => null, tagName: 'DIV' } as unknown as Element
  }
  function closestHit(selector: string): Element {
    return {
      closest: (s: string) => (s === selector ? {} : null),
      tagName: 'DIV',
    } as unknown as Element
  }
  function articleContaining(contains: () => boolean): Element {
    return { contains } as unknown as Element
  }

  it('routes an input/textarea activeElement to the native input select', () => {
    const input = { tagName: 'INPUT' } as unknown as Element
    expect(
      resolveSelectAllTarget(
        null,
        input,
        articleContaining(() => false),
      ),
    ).toBe('input')
    const textarea = { tagName: 'TEXTAREA' } as unknown as Element
    expect(
      resolveSelectAllTarget(
        null,
        textarea,
        articleContaining(() => false),
      ),
    ).toBe('input')
  })

  it('routes a selection anchored inside CodeMirror content to the editor', () => {
    expect(
      resolveSelectAllTarget(
        closestHit('.cm-content'),
        null,
        articleContaining(() => false),
      ),
    ).toBe('editor')
  })

  it('routes focus inside the CodeMirror editor to the editor (even with no anchor)', () => {
    expect(
      resolveSelectAllTarget(
        null,
        closestHit('.cm-editor'),
        articleContaining(() => false),
      ),
    ).toBe('editor')
  })

  it('routes focus on the editor pane container to the editor (Radix trigger after a menu closes)', () => {
    expect(
      resolveSelectAllTarget(
        null,
        closestHit('.editor-content'),
        articleContaining(() => false),
      ),
    ).toBe('editor')
  })

  it('routes a selection anchored inside the preview article to the preview', () => {
    expect(
      resolveSelectAllTarget(
        fakeEl(),
        null,
        articleContaining(() => true),
      ),
    ).toBe('preview')
  })

  it('routes focus on/inside the preview article to the preview', () => {
    expect(
      resolveSelectAllTarget(
        null,
        fakeEl(),
        articleContaining(() => true),
      ),
    ).toBe('preview')
    // The article ITSELF is focused (it carries tabIndex=0): identity match, no contains().
    const article = document.createElement('article')
    expect(resolveSelectAllTarget(null, article, article)).toBe('preview')
  })

  it('does nothing when the focus has no select-all target (sidebar / body)', () => {
    // No input, no editor, no preview involvement: Ctrl+A must not yank focus into a pane.
    expect(
      resolveSelectAllTarget(
        null,
        null,
        articleContaining(() => false),
      ),
    ).toBe('none')
    expect(resolveSelectAllTarget(fakeEl(), fakeEl(), null)).toBe('none')
    // An anchor/active element that is NOT in the article and NOT in the editor → none.
    expect(
      resolveSelectAllTarget(
        fakeEl(),
        null,
        articleContaining(() => false),
      ),
    ).toBe('none')
    expect(
      resolveSelectAllTarget(
        null,
        fakeEl(),
        articleContaining(() => false),
      ),
    ).toBe('none')
  })
})

describe('routeSelectAll (wiring)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('native-selects the focused input/textarea', () => {
    const input = document.createElement('input')
    input.value = 'rename me'
    document.body.appendChild(input)
    input.focus()
    routeSelectAll()
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
    input.remove()
  })

  it('dispatches markdown:select-all for the editor path (CM owns the selection)', () => {
    const spy = vi.spyOn(document, 'dispatchEvent')
    // No input focused and no article/anchor in this clean document, but the CV owner is
    // the editor container — focus the editor pane so the editor branch is taken.
    const pane = document.createElement('div')
    pane.className = 'editor-content'
    pane.tabIndex = 0 // focusable: a plain div would leave activeElement on body
    document.body.appendChild(pane)
    pane.focus()
    routeSelectAll()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0].type).toBe('markdown:select-all')
    pane.remove()
  })

  it('does nothing when the focus has no select-all target', () => {
    const spy = vi.spyOn(document, 'dispatchEvent')
    routeSelectAll()
    expect(spy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'markdown:select-all' }))
  })

  it('scopes the preview select-all to the article (never the whole document)', () => {
    const article = document.createElement('article')
    article.className = 'markdown-preview'
    article.tabIndex = 0
    article.textContent = 'preview body'
    document.body.appendChild(article)
    // Selection anchor inside the article → preview branch.
    const anchor = article.firstChild as Node
    const fakeSel = {
      anchorNode: anchor,
      removeAllRanges: vi.fn(),
      selectAllChildren: vi.fn(),
    } as unknown as Selection
    routeSelectAll({ getSelection: () => fakeSel } as unknown as Window, document)
    expect(fakeSel.selectAllChildren).toHaveBeenCalledWith(article)
    article.remove()
  })

  it('handles a document whose activeElement is not an Element (defensive)', () => {
    const article = document.createElement('article')
    article.className = 'markdown-preview'
    article.textContent = 'preview body'
    document.body.appendChild(article)
    const fakeSel = {
      anchorNode: article.firstChild,
      removeAllRanges: vi.fn(),
      selectAllChildren: vi.fn(),
    } as unknown as Selection
    const fakeDoc = {
      activeElement: null,
      // Only answer the article query; a catch-all would also "find" a Radix menu and send
      // this test down the menu-dismiss path.
      querySelector: (s: string) => (s.includes('markdown-preview') ? article : null),
      dispatchEvent: vi.fn(),
    } as unknown as Document
    routeSelectAll(
      { getSelection: () => fakeSel, setTimeout: vi.fn() } as unknown as Window,
      fakeDoc,
    )
    expect(fakeSel.selectAllChildren).toHaveBeenCalledWith(article)
    article.remove()
  })

  it('accepts an element (not just a text node) as the selection anchor', () => {
    const article = document.createElement('article')
    article.className = 'markdown-preview'
    article.textContent = 'preview body'
    document.body.appendChild(article)
    const fakeSel = {
      anchorNode: article, // element node → nodeType !== 3 branch
      removeAllRanges: vi.fn(),
      selectAllChildren: vi.fn(),
    } as unknown as Selection
    routeSelectAll({ getSelection: () => fakeSel } as unknown as Window, document)
    expect(fakeSel.selectAllChildren).toHaveBeenCalledWith(article)
    article.remove()
  })

  it('routes to the preview when the article itself has focus (no live selection)', () => {
    const article = document.createElement('article')
    article.className = 'markdown-preview'
    article.tabIndex = 0
    document.body.appendChild(article)
    article.focus()
    // No selection at all: the optional-chained calls must simply be skipped (no throw).
    expect(() =>
      routeSelectAll({ getSelection: () => null } as unknown as Window, document),
    ).not.toThrow()
    article.remove()
  })

  it('takes over Ctrl+A that reaches the renderer and routes it (no document-wide select-all)', () => {
    const article = document.createElement('article')
    article.className = 'markdown-preview'
    article.textContent = 'preview body'
    document.body.appendChild(article)
    const fakeSel = {
      anchorNode: article.firstChild,
      removeAllRanges: vi.fn(),
      selectAllChildren: vi.fn(),
    } as unknown as Selection
    const handler = createSelectAllKeydownHandler(
      { getSelection: () => fakeSel, setTimeout: vi.fn() } as unknown as Window,
      document,
    )
    const preventDefault = vi.fn()
    handler({
      key: 'a',
      ctrlKey: true,
      defaultPrevented: false,
      preventDefault,
    } as unknown as KeyboardEvent)
    // The browser default (whole-document select-all) is killed…
    expect(preventDefault).toHaveBeenCalledTimes(1)
    // …and the routed action runs instead (anchor is inside the article → preview).
    expect(fakeSel.selectAllChildren).toHaveBeenCalledWith(article)
    article.remove()
  })

  it('takes over Cmd+A (meta) and upper-case "A" as well', () => {
    const handler = createSelectAllKeydownHandler(
      { getSelection: () => null, setTimeout: vi.fn() } as unknown as Window,
      document,
    )
    const preventDefault = vi.fn()
    handler({
      key: 'A',
      metaKey: true,
      defaultPrevented: false,
      preventDefault,
    } as unknown as KeyboardEvent)
    expect(preventDefault).toHaveBeenCalledTimes(1)
  })

  it('leaves already-handled and non-select-all key events alone', () => {
    const handler = createSelectAllKeydownHandler(
      { getSelection: () => null, setTimeout: vi.fn() } as unknown as Window,
      document,
    )
    for (const init of [
      { key: 'a', ctrlKey: true, defaultPrevented: true }, // CodeMirror/preview already took it
      { key: 'a' }, // no modifier
      { key: 'b', ctrlKey: true }, // other key
      { key: 'a', ctrlKey: true, shiftKey: true },
      { key: 'a', ctrlKey: true, altKey: true },
    ]) {
      const preventDefault = vi.fn()
      handler({ defaultPrevented: false, ...init, preventDefault } as unknown as KeyboardEvent)
      expect(preventDefault).not.toHaveBeenCalled()
    }
  })

  // A right-click menu owns the focus while it is open: Ctrl+A must dismiss it FIRST and
  // only then decide (by the restored focus) which pane to select — never act on the menu.
  it('closes an open Radix menu and re-routes after the focus is restored', () => {
    vi.useFakeTimers()
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    menu.setAttribute('data-state', 'open')
    document.body.appendChild(menu)
    const dispatchSpy = vi.spyOn(document, 'dispatchEvent')
    const setTimeoutSpy = vi.fn()
    routeSelectAll(
      { getSelection: () => null, setTimeout: setTimeoutSpy } as unknown as Window,
      document,
    )
    // Escape is the menu's own dismiss key → the menu closes.
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'keydown' }))
    // …and the routing decision is deferred to the next tick (no double-action now).
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
    menu.remove()
    // Run the deferred pass (the menu is gone, so it must route normally, not loop).
    const deferred = setTimeoutSpy.mock.calls[0]?.[0] as () => void
    expect(typeof deferred).toBe('function')
    expect(() => deferred()).not.toThrow()
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1) // no second scheduling → no loop
    vi.useRealTimers()
  })
})
