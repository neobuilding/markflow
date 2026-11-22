// Shared per-window close handshake: `app:quit-pending`.
//
// The renderer answers `app:request-quit` with `app:quit-pending` when it opens the unsaved-changes
// dialog. That disarms the 5s "renderer is dead" safety net for THAT window only — otherwise a
// prompt in window A would silently disable window B's net. Resolving the sender to a WindowContext
// here gives per-window isolation. Resolution is EXACT (no active-window fallback), matching
// `app:quit-allowed`: a report from a destroyed or unknown renderer must never disarm the window
// that happens to be focused (ADR-0039 §3.4).
//
// The listener is registered ONCE at module scope by lifecycle.ts importing this module. Only this
// module registers the channel — de-duplicating the old double registration (window.ts and
// lifecycle.ts) that made N windows disarm N safety nets. ADR-0039 §4 requires every IPC listener
// to go through scopedOnFor; the explicit exactContextFor below still decides attribution (no
// active-window fallback), the scope wrapper only keeps the ALS context consistent for the chain.
import { ipcMain } from 'electron'
import { scopedOnFor } from './ipcScope'
import { exactContextFor } from './windowContext'

type Sender = { id: number } | null | undefined

/** Renderer opened its unsaved-changes dialog for the window identified by `source`. */
export function markQuitPending(source?: Sender): void {
  const ctx = exactContextFor(source)
  if (ctx) ctx.quitPending = true
}

scopedOnFor(ipcMain, 'app:quit-pending', (event) => markQuitPending(event?.sender))
