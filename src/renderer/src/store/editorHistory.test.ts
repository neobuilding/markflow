import { describe, it, expect, beforeEach } from 'vitest'
import { useEditorHistory } from './editorHistory'

beforeEach(() => {
  useEditorHistory.getState().reset()
})

describe('editorHistory store', () => {
  it('starts with no history', () => {
    expect(useEditorHistory.getState().canUndo).toBe(false)
    expect(useEditorHistory.getState().canRedo).toBe(false)
  })

  it('publishes the booleans the editor reports', () => {
    useEditorHistory.getState().update({ canUndo: true, canRedo: false })
    expect(useEditorHistory.getState().canUndo).toBe(true)
    expect(useEditorHistory.getState().canRedo).toBe(false)
    useEditorHistory.getState().update({ canUndo: true, canRedo: true })
    expect(useEditorHistory.getState().canRedo).toBe(true)
  })

  it('ignores an update that does not change anything', () => {
    const before = useEditorHistory.getState()
    useEditorHistory.getState().update({ canUndo: false, canRedo: false })
    // Same object identity => no store notification => no needless re-render of the pane bar.
    expect(useEditorHistory.getState()).toBe(before)
  })

  it('notifies subscribers when a boolean flips', () => {
    const seen: boolean[] = []
    const unsub = useEditorHistory.subscribe((s) => seen.push(s.canUndo))
    useEditorHistory.getState().update({ canUndo: true, canRedo: false })
    useEditorHistory.getState().update({ canUndo: true, canRedo: false })
    expect(seen).toEqual([true])
    unsub()
  })

  it('clears the history on reset, so a remounted editor starts with nothing to undo', () => {
    // The editor pane unmounts in preview-only mode; a fresh CodeMirror instance has an empty
    // history, so the store must not keep the previous instance's booleans.
    useEditorHistory.getState().update({ canUndo: true, canRedo: true })
    useEditorHistory.getState().reset()
    expect(useEditorHistory.getState().canUndo).toBe(false)
    expect(useEditorHistory.getState().canRedo).toBe(false)
  })

  it('reset is idempotent and does not notify when already empty', () => {
    const before = useEditorHistory.getState()
    useEditorHistory.getState().reset()
    expect(useEditorHistory.getState()).toBe(before)
  })
})
