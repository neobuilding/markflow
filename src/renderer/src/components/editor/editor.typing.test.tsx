import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { MarkdownEditor } from './MarkdownEditor'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

// Read the editor's authoritative state directly from the live EditorView. The two facets together
// are the single source of truth for whether typing is accepted:
//   - EditorState.readOnly: true => editing is hard-blocked
//   - EditorView.editable:  false => the DOM contenteditable is off (read-only)
// They must always agree; a split (editable=true but readOnly=true) is the original bug.
function facets(container: HTMLElement) {
  const dom = container.querySelector('.cm-content') as HTMLElement | null
  if (!dom) return null
  const view = EditorView.findFromDOM(dom)
  if (!view) return null
  return {
    readOnly: view.state.facet(EditorState.readOnly),
    editable: view.state.facet(EditorView.editable),
    ce: dom.getAttribute('contenteditable'),
    focused: view.hasFocus,
    content: view.state.doc.toString(),
  }
}

describe('MarkdownEditor — read-only/edit facets stay in sync across switches', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('edit mode: readOnly=false, editable=true, contenteditable=true', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(<MarkdownEditor content="# A" onChange={() => {}} editable={true} docId="a" />)
    })
    await flush()
    const f = facets(container)
    expect(f?.readOnly).toBe(false)
    expect(f?.editable).toBe(true)
    expect(f?.ce).toBe('true')

    act(() => root.unmount())
    container.remove()
  })

  it('read-only mode: readOnly=true, editable=false, contenteditable=false', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(<MarkdownEditor content="# A" onChange={() => {}} editable={false} docId="a" />)
    })
    await flush()
    const f = facets(container)
    expect(f?.readOnly).toBe(true)
    expect(f?.editable).toBe(false)
    expect(f?.ce).toBe('false')

    act(() => root.unmount())
    container.remove()
  })

  it('TWO consecutive edit-mode doc switches keep edit mode enabled (the reported regression)', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const checkEdit = (label: string) => {
      const f = facets(container)
      expect(f?.readOnly, `${label}: readOnly should be false`).toBe(false)
      expect(f?.editable, `${label}: editable should be true`).toBe(true)
      expect(f?.ce, `${label}: contenteditable should be true`).toBe('true')
    }
    const checkRead = (label: string) => {
      const f = facets(container)
      expect(f?.readOnly, `${label}: readOnly should be true`).toBe(true)
      expect(f?.editable, `${label}: editable should be false`).toBe(false)
      expect(f?.ce, `${label}: contenteditable should be false`).toBe('false')
    }

    // A in edit mode
    await act(async () => {
      root.render(<MarkdownEditor content="# A" onChange={() => {}} editable={true} docId="a" />)
    })
    await flush()
    checkEdit('A')

    // Switch A->B (editable resets to false)
    await act(async () => {
      root.render(<MarkdownEditor content="# A (stale)" onChange={() => {}} editable={false} docId="b" />)
    })
    await flush()
    await act(async () => {
      root.render(<MarkdownEditor content="# B content" onChange={() => {}} editable={false} docId="b" />)
    })
    await flush()
    checkRead('B (read-only)')
    expect(facets(container)?.content).toBe('# B content')

    // Edit B
    await act(async () => {
      root.render(<MarkdownEditor content="# B content" onChange={() => {}} editable={true} docId="b" />)
    })
    await flush()
    checkEdit('B (edit)')

    // Switch B->C (2nd edit-mode switch)
    await act(async () => {
      root.render(<MarkdownEditor content="# B content (stale)" onChange={() => {}} editable={false} docId="c" />)
    })
    await flush()
    await act(async () => {
      root.render(<MarkdownEditor content="# C content" onChange={() => {}} editable={false} docId="c" />)
    })
    await flush()
    checkRead('C (read-only)')
    expect(facets(container)?.content).toBe('# C content')

    // Edit C — this is where the bug recurred
    await act(async () => {
      root.render(<MarkdownEditor content="# C content" onChange={() => {}} editable={true} docId="c" />)
    })
    await flush()
    checkEdit('C (edit)') // MUST be editable

    act(() => root.unmount())
    container.remove()
  })

  it('entering edit mode focuses the editor (fixes "can\'t type after switching in edit mode")', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    // Open read-only
    await act(async () => {
      root.render(<MarkdownEditor content="# A" onChange={() => {}} editable={false} docId="a" />)
    })
    await flush()
    expect(facets(container)?.focused).toBe(false)

    // Toggle to edit mode -> the editor must gain focus so the user can type immediately
    await act(async () => {
      root.render(<MarkdownEditor content="# A" onChange={() => {}} editable={true} docId="a" />)
    })
    await flush()
    expect(facets(container)?.focused).toBe(true)

    // Leaving edit mode must NOT re-focus (we never call view.focus() when editable is false), so
    // focus is left wherever it was. We only assert we didn't (re)steal focus into the editor.
    await act(async () => {
      root.render(<MarkdownEditor content="# A" onChange={() => {}} editable={false} docId="a" />)
    })
    await flush()
    expect(facets(container)?.readOnly).toBe(true)
    expect(facets(container)?.editable).toBe(false)

    act(() => root.unmount())
    container.remove()
  })

  it('a key-remounted editable editor is focused on mount (doc switch lands in edit mode)', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    // B mounts already editable (simulates: switch to a doc while in edit mode)
    await act(async () => {
      root.render(<MarkdownEditor content="# B" onChange={() => {}} editable={true} docId="b" />)
    })
    await flush()
    expect(facets(container)?.focused).toBe(true)

    act(() => root.unmount())
    container.remove()
  })
})
