import { create } from 'zustand'

// Live undo/redo availability for the CodeMirror editor. The editor pane bar shows always-visible
// undo/redo buttons whose disabled state must track the document history in real time (ADR-0024 §10
// trade-off 47). The editor's right-click menu only snapshots `canUndo`/`canRedo` when it opens,
// which is insufficient for a persistent toolbar button, so the editor publishes the booleans here
// from its `updateListener` and the pane bar subscribes.
interface EditorHistoryState {
  canUndo: boolean
  canRedo: boolean
  update: (next: { canUndo: boolean; canRedo: boolean }) => void
  reset: () => void
}

export const useEditorHistory = create<EditorHistoryState>((set, get) => ({
  canUndo: false,
  canRedo: false,
  update: (next) => {
    // Compare against the store's CURRENT state, not a module-level mirror: a mirror can drift
    // from the real state (e.g. after `reset()`, or a direct `setState` in a test) and would then
    // swallow a legitimate update. `updateListener` fires on every transaction, so skip the
    // no-op case to keep the store quiet.
    const cur = get()
    if (cur.canUndo === next.canUndo && cur.canRedo === next.canRedo) return
    set(next)
  },
  reset: () => {
    // The editor pane is unmounted in preview-only mode, and a fresh CodeMirror instance starts
    // with an EMPTY history. Without this reset the store would keep the booleans from the
    // previous instance, leaving the undo/redo buttons enabled while `undo()` had nothing to undo.
    const cur = get()
    if (!cur.canUndo && !cur.canRedo) return
    set({ canUndo: false, canRedo: false })
  },
}))
