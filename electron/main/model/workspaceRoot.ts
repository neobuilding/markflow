// The single authoritative workspace root (ADR-0023).
//
// Why this module exists: the folder watcher used to keep a *set* of opened folders
// (`model/openFolders.ts`), and "the workspace root" was implicitly derived from that set by
// taking its first/last element — undefined behaviour, because a set has no order the user
// agreed to. The product is a SINGLE-ROOT workspace (D20): opening a folder replaces the
// workspace, so there is exactly one root at any time (or none).
//
// The watcher is now a pure function of this value, and search / replace read it directly
// (they must never read a "watched folder set" — D13).
import { resolve } from 'node:path'

let workspaceRoot: string | null = null
// Bumped every time the root changes, so in-flight replace plans can detect that the workspace
// they were built against no longer exists (D29: a planId is bound to the root AND the session).
let workspaceSession = 0

// Normalize for comparison and for `relativePath`: absolute, no trailing separator. The stored
// value keeps the platform's native separators on purpose — it is handed to `fs` and to
// `relativePath`, both of which understand them, and re-normalizing to `/` here would break
// `path.resolve`-based comparisons on Windows.
function norm(p: string): string {
  return resolve(p).replace(/[\\/]+$/, '')
}

export function getWorkspaceRoot(): string | null {
  return workspaceRoot
}

// Set (or clear) the root. Returns true when the root actually changed.
// A no-op assignment must NOT bump the session: re-opening the same folder must not invalidate
// plans that are legitimately still describing the same workspace.
export function setWorkspaceRoot(next: string | null): boolean {
  const value = next ? norm(next) : null
  if (value === workspaceRoot) return false
  workspaceRoot = value
  workspaceSession += 1
  return true
}

// Monotonic counter bumped on every root change. Exposed so a replace plan can bind itself to
// "the workspace as it was when I was computed" (D29).
export function getWorkspaceSession(): number {
  return workspaceSession
}

// Test seam: restore module state between unit tests. Production code never calls this.
export function __resetWorkspaceRootForTests(): void {
  workspaceRoot = null
  workspaceSession = 0
}
