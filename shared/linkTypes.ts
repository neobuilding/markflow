// ADR-0038 §3.1.3: the choice returned by the Open / Copy / Cancel confirmation shown before a
// preview link hands an external URL or a local non-Markdown file to the OS. This travels over IPC
// (main → preload → renderer), so it is declared once here rather than repeated at each boundary.
export type ExternalOpenChoice = 'open' | 'copy' | 'cancel'

/**
 * The four-way choice shown when a Markdown link (or a dropped/associated single file) lands
 * OUTSIDE the current workspace. Mirrors the browser-style "where should this open?" decision:
 * a separate window, here without changing the workspace, here WITH a workspace switch, or nothing.
 * Crosses the IPC boundary, so it is defined once here.
 */
export type WorkspaceExternalChoice =
  'new-window' | 'keep-workspace' | 'switch-workspace' | 'cancel'
