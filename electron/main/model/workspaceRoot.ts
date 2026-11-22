// The authoritative workspace root (ADR-0023), now scoped per window.
//
// Why this module exists: the folder watcher used to keep a *set* of opened folders
// (`model/openFolders.ts`), and "the workspace root" was implicitly derived from that set by
// taking its first/last element — undefined behaviour, because a set has no order the user
// agreed to. The product is a SINGLE-ROOT workspace (D20): opening a folder replaces the
// workspace, so there is exactly one root per window at any time (or none).
//
// The root and its session counter live in the WindowContext (see windowContext.ts); the ALS-based
// currentContext() makes these accessors resolve to whichever window issued the IPC call.
import { resolve } from 'node:path'
import { currentContext, type WindowContext } from './windowContext'

// Normalize for comparison and for `relativePath`: absolute, no trailing separator. The stored
// value keeps the platform's native separators on purpose — it is handed to `fs` and to
// `relativePath`, both of which understand them, and re-normalizing to `/` here would break
// `path.resolve`-based comparisons on Windows.
function norm(p: string): string {
  return resolve(p).replace(/[\\/]+$/, '')
}

export function getWorkspaceRoot(): string | null {
  return currentContext().workspaceRoot
}

// Set (or clear) the root. Returns true when the root actually changed.
// A no-op assignment must NOT bump the session: re-opening the same folder must not invalidate
// plans that are legitimately still describing the same workspace.
//
// `ctx` names the window explicitly. It is REQUIRED whenever the caller is not acting on behalf
// of the window it changes: `createWindow` runs inside the IPC scope of the window that asked for
// the new one, so the implicit `currentContext()` would write the new window's root into the
// CALLER's window — two windows would then share one root.
export function setWorkspaceRoot(next: string | null, ctx?: WindowContext): boolean {
  const target = ctx ?? currentContext()
  const value = next ? norm(next) : null
  if (value === target.workspaceRoot) return false
  target.workspaceRoot = value
  target.workspaceSession += 1
  return true
}

// Monotonic counter bumped on every root change. Exposed so a replace plan can bind itself to
// "the workspace as it was when I was computed" (D29).
export function getWorkspaceSession(): number {
  return currentContext().workspaceSession
}

// Test seam: restore the active context's root state between unit tests. Production code never
// calls this.
export function __resetWorkspaceRootForTests(): void {
  const ctx = currentContext()
  ctx.workspaceRoot = null
  ctx.workspaceSession = 0
}
