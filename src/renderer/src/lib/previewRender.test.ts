import { describe, it, expect } from 'vitest'
import { patchPreviewContent, DATA_BAKED } from './previewRender'
import { sanitizeHtml } from './sanitize'

describe('patchPreviewContent — incremental DOM patch (R4)', () => {
  it('patches sanitized HTML into the root as its children (childrenOnly)', () => {
    const root = document.createElement('div')
    patchPreviewContent(root, sanitizeHtml('<h1>Hi</h1><p>body</p>'))
    expect(root.querySelector('h1')?.textContent).toBe('Hi')
    expect(root.querySelector('p')?.textContent).toBe('body')
    // The root itself is NOT replaced (only its children are morphed).
    expect(root.tagName).toBe('DIV')
  })

  it('reuses unchanged subtrees across patches (no flicker, listeners preserved)', () => {
    const root = document.createElement('div')
    patchPreviewContent(root, sanitizeHtml('<p>stable</p>'))
    const first = root.querySelector('p')!
    // Same content again: morphdom should keep the existing node, not recreate it.
    patchPreviewContent(root, sanitizeHtml('<p>stable</p>'))
    expect(root.querySelector('p')).toBe(first)
  })

  it('updates a node when its content changed (reusing the same element — R4)', () => {
    const root = document.createElement('div')
    patchPreviewContent(root, sanitizeHtml('<p>one</p>'))
    const first = root.querySelector('p')!
    patchPreviewContent(root, sanitizeHtml('<p>two</p>'))
    // The text content is updated to the new value.
    expect(root.querySelector('p')?.textContent).toBe('two')
    // R4: morphdom reconciles IN PLACE — the SAME <p> element instance survives the patch
    // (only its text child changes), so any listeners / scroll state on it are preserved.
    // This is the "no full subtree rebuild" guarantee; a correct incremental patch keeps
    // `first` as the live node rather than discarding and recreating it.
    expect(root.querySelector('p')).toBe(first)
  })

  it('is a no-op (no throw) when the root is null', () => {
    expect(() =>
      patchPreviewContent(null as unknown as HTMLElement, sanitizeHtml('<p>x</p>')),
    ).not.toThrow()
  })

  it('forces an update of a runtime-injected (baked) node instead of skipping it', () => {
    // The image-error placeholder is mutated at runtime (not reflected in the HTML string);
    // mark it with DATA_BAKED so a fresh render re-establishes the correct node.
    const root = document.createElement('div')
    root.innerHTML = `<span ${DATA_BAKED}="1">old placeholder</span>`
    patchPreviewContent(root, sanitizeHtml('<span>new content</span>'))
    const span = root.querySelector('span')
    expect(span?.textContent).toBe('new content')
    // The stale data-baked marker must not survive the reconciliation.
    expect(span?.hasAttribute(DATA_BAKED)).toBe(false)
  })

  it('exposes the DATA_BAKED marker constant', () => {
    expect(DATA_BAKED).toBe('data-baked')
  })
})
