// ADR-0040: document tabs and cross-window tab transfer. These shapes travel over
// IPC (main → preload → renderer), so they are declared once here rather than
// repeated at every boundary.

/** How a history entry's document was opened; replayed by Back/Forward without re-prompting. */
export type TabOpenMode = 'in-place' | 'external-keep' | 'external-switch'

export interface TabHistoryEntry {
  path: string
  title?: string
  openMode?: TabOpenMode
  /** ADR-0042: workspace root to restore when replaying a cross-switch entry. */
  replayRoot?: string
  /** ADR-0042: tab that displayed the entry and the editor range at that point. */
  tabId?: string
  position?: { start: number; end: number }
}

/**
 * Complete in-memory state of a tab being moved between windows. A partial handoff
 * would silently lose the draft title or the per-tab history stack, so keep every
 * field required (use `null` for "no draft" rather than omitting the field).
 */
export interface TabHandoff {
  /** Stable tab identity: the destination seeds a tab with this same id. */
  tabId: string
  /** Document id in the SOURCE window; the destination re-imports and gets a new one. */
  documentId: string
  /** Absolute path; empty string for a memory-only draft. */
  filePath: string
  /** Draft body when dirty, `null` when clean (destination reads from disk). */
  content: string | null
  /** Draft title in display form (extension included), not the on-disk file name. */
  title: string
  /** Whether the source rendered this document with the external badge. */
  external: boolean
  /** Whether the document is an unsaved new document (Save As on first save). */
  isNewUnsaved: boolean
  /** Original line ending, restored on save. */
  eol: '\r\n' | '\n'
  /** Per-tab navigation history, replayed verbatim at the destination. */
  history: TabHistoryEntry[]
  /** Index into `history` of the currently shown entry. */
  cursor: number
}

export type TabDragResult = 'consumed' | 'expired' | 'no-session' | 'same-window'

/** One entry of the "move tab to another window" picker. `id` is webContents.id. */
export interface TabWindowInfo {
  id: number
  title: string
}
