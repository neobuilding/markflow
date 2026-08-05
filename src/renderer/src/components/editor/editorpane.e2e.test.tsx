import React, { useState } from 'react'
import { describe, it, expect } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { MarkdownEditor } from './MarkdownEditor'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

// Minimal re-creation of EditorPane's editor-mounting structure:
// - editable + activeDocumentId come from the parent (like useUIStore)
// - MarkdownEditor is keyed by activeDocumentId (like EditorPane now does)
// - rendered only when viewMode !== 'preview'
function Harness({
  editable,
  activeDocumentId,
  content,
  viewMode,
}: {
  editable: boolean
  activeDocumentId: string
  content: string
  viewMode: 'edit' | 'split' | 'preview'
}) {
  if (viewMode === 'preview') return <div>preview</div>
  return (
    <MarkdownEditor
      key={activeDocumentId}
      content={content}
      onChange={() => {}}
      editable={editable}
      docId={activeDocumentId}
    />
  )
}

function ce(container: HTMLElement): string | null {
  return container.querySelector('.cm-content')?.getAttribute('contentEditable') ?? null
}

// With the editor using a single EditorView.editable facet, "read-only" is reflected purely by the
// .cm-content contenteditable attribute (false == read-only, true == editable). There is no separate
// hard read-only facet, so this is the single source of truth for whether typing is accepted.
function isReadonly(container: HTMLElement): boolean {
  return container.querySelector('.cm-content')?.getAttribute('contentEditable') !== 'true'
}

describe('EditorPane-style editing across doc switches', () => {
  it('open file (read-only) -> click edit -> switch file: new file is editable', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    // Initial: no doc
    await act(async () => {
      root.render(<Harness editable={false} activeDocumentId="a" content="# A" viewMode="split" />)
    })
    await flush()
    expect(ce(container)).toBe('false') // A read-only

    // User clicks "edit" (editable becomes true) while on A
    await act(async () => {
      root.render(<Harness editable={true} activeDocumentId="a" content="# A" viewMode="split" />)
    })
    await flush()
    expect(ce(container)).toBe('true') // A editable

    // User switches to file B (activeDocumentId changes -> new key -> remount)
    await act(async () => {
      root.render(<Harness editable={true} activeDocumentId="b" content="# B" viewMode="split" />)
    })
    await flush()
    // EXPECTED: B should remain editable (user is in edit mode). BUG if still false.
    expect(ce(container)).toBe('true')
    expect(container.querySelector('.cm-content')?.textContent).toBe('# B')

    act(() => root.unmount())
    container.remove()
  })

  it('read-only doc switch (no key / instance reuse) updates content and stays editable', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    // No `key`: editor instance is reused across doc switches (pre-key behavior).
    const renderNoKey = (editable: boolean, id: string, content: string) =>
      root.render(
        <MarkdownEditor content={content} onChange={() => {}} editable={editable} docId={id} />,
      )

    // Open A in read-only mode (the default for opened files)
    await act(async () => {
      renderNoKey(false, 'a', '# A')
    })
    await flush()
    expect(ce(container)).toBe('false')

    // Switch to B while still read-only -> the content write must NOT be rejected by readOnly,
    // and must NOT leave isApplyingExternal stuck (which would swallow edits afterwards).
    await act(async () => {
      renderNoKey(false, 'b', '# B content')
    })
    await flush()
    expect(container.querySelector('.cm-content')?.textContent).toBe('# B content')

    // Now switch to edit mode on B
    await act(async () => {
      renderNoKey(true, 'b', '# B content')
    })
    await flush()
    expect(ce(container)).toBe('true')
    // content must still be correct (not reverted to A) after toggling edit
    expect(container.querySelector('.cm-content')?.textContent).toBe('# B content')

    act(() => root.unmount())
    container.remove()
  })

  it('async content switch on same key while read-only loads correct content (real EditorPane timing)', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    // EditorPane mounts a NEW doc key, but localContent is still the PREVIOUS doc's content for
    // one render (useLocalDocument updates async). So the editor is created with stale content.
    await act(async () => {
      root.render(<MarkdownEditor key="b" content="# A (stale)" onChange={() => {}} editable={false} docId="b" />)
    })
    await flush()
    expect(container.querySelector('.cm-content')?.textContent).toBe('# A (stale)')

    // Then useLocalDocument updates localContent to the real doc B content. Same key -> no remount,
    // content prop changes -> content effect runs. Editor is read-only here, so the write must not
    // be rejected and must not leave isApplyingExternal stuck.
    await act(async () => {
      root.render(<MarkdownEditor key="b" content="# B real" onChange={() => {}} editable={false} docId="b" />)
    })
    await flush()
    expect(container.querySelector('.cm-content')?.textContent).toBe('# B real')

    // Now switch to edit mode
    await act(async () => {
      root.render(<MarkdownEditor key="b" content="# B real" onChange={() => {}} editable={true} docId="b" />)
    })
    await flush()
    expect(ce(container)).toBe('true')
    expect(container.querySelector('.cm-content')?.textContent).toBe('# B real')

    act(() => root.unmount())
    container.remove()
  })

  it('editing mode -> switch file -> edit again: readOnly facet is cleared (no stuck readonly)', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    // Open A in EDIT mode (this is the user's "editing mode" starting point)
    await act(async () => {
      root.render(<Harness editable={true} activeDocumentId="a" content="# A" viewMode="split" />)
    })
    await flush()
    expect(ce(container)).toBe('true')
    expect(isReadonly(container)).toBe(false)

    // Switch to B. Because setActiveDocumentId resets editable to false, editable goes true->false
    // while switching. This is exactly the sequence the user reports as breaking editing.
    await act(async () => {
      root.render(<Harness editable={false} activeDocumentId="b" content="# B" viewMode="split" />)
    })
    await flush()
    expect(ce(container)).toBe('false')
    expect(isReadonly(container)).toBe(true)

    // User clicks "edit" on B -> editable false->true
    await act(async () => {
      root.render(<Harness editable={true} activeDocumentId="b" content="# B" viewMode="split" />)
    })
    await flush()
    // The hard read-only facet MUST be cleared so the editor actually accepts input.
    expect(isReadonly(container)).toBe(false)
    expect(ce(container)).toBe('true')

    act(() => root.unmount())
    container.remove()
  })

  it('TWO consecutive editing-mode file switches (no key, reused instance) must both stay editable', async () => {
    // Simulates the real EditorPane: the MarkdownEditor instance is REUSED across switches
    // (no remount), content arrives asynchronously, and the user edits between switches.
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    // --- File A in EDIT mode (starting point) ---
    await act(async () => {
      root.render(<MarkdownEditor content="# A" onChange={() => {}} editable={true} docId="a" />)
    })
    await flush()
    expect(ce(container)).toBe('true')

    // Switch to B: editable resets to false. Content arrives one render later (stale then real).
    await act(async () => {
      root.render(<MarkdownEditor content="# A (stale)" onChange={() => {}} editable={false} docId="b" />)
    })
    await flush()
    await act(async () => {
      root.render(<MarkdownEditor content="# B content" onChange={() => {}} editable={false} docId="b" />)
    })
    await flush()
    expect(ce(container)).toBe('false')
    expect(container.querySelector('.cm-content')?.textContent).toBe('# B content')

    // Click edit on B -> editable
    await act(async () => {
      root.render(<MarkdownEditor content="# B content" onChange={() => {}} editable={true} docId="b" />)
    })
    await flush()
    expect(ce(container)).toBe('true')

    // --- SECOND editing-mode switch: B(edit) -> C ---
    // User was editing B, now switches to C (editable resets to false), content async.
    await act(async () => {
      root.render(<MarkdownEditor content="# B content (stale)" onChange={() => {}} editable={false} docId="c" />)
    })
    await flush()
    await act(async () => {
      root.render(<MarkdownEditor content="# C content" onChange={() => {}} editable={false} docId="c" />)
    })
    await flush()
    expect(ce(container)).toBe('false')
    expect(container.querySelector('.cm-content')?.textContent).toBe('# C content')

    // Click edit on C -> MUST be editable (this is where the bug recurs on the 2nd switch)
    await act(async () => {
      root.render(<MarkdownEditor content="# C content" onChange={() => {}} editable={true} docId="c" />)
    })
    await flush()
    expect(ce(container)).toBe('true')
    expect(container.querySelector('.cm-content')?.textContent).toBe('# C content')

    act(() => root.unmount())
    container.remove()
  })

  it('preview mode hides editor; switching back keeps edit mode', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(<Harness editable={true} activeDocumentId="a" content="# A" viewMode="edit" />)
    })
    await flush()
    expect(ce(container)).toBe('true')

    // Switch to preview (editor unmounts)
    await act(async () => {
      root.render(<Harness editable={true} activeDocumentId="a" content="# A" viewMode="preview" />)
    })
    await flush()
    expect(container.querySelector('.cm-content')).toBeNull()

    // Back to edit (editor remounts, should be editable)
    await act(async () => {
      root.render(<Harness editable={true} activeDocumentId="a" content="# A" viewMode="edit" />)
    })
    await flush()
    expect(ce(container)).toBe('true')

    act(() => root.unmount())
    container.remove()
  })
})
