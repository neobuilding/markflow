// The set of folders the user has opened, which the folder watcher keeps in sync
// with the filesystem (see model/folderWatcher.ts).
//
// Why a *set* rather than the single "active folder" the renderer tracks: the
// sidebar lets the user drill into a subfolder (Sidebar -> setActiveFolder),
// so the path being displayed can be nested below the folder the user actually
// opened. Watching only the displayed path would silently stop watching the
// sibling sub-trees, and files created there would never enter the store. We
// therefore remember every folder the user opened at the top level and watch
// all of them.
//
// The renderer replaces `activeFolder` when it opens another folder, so this set
// only ever accumulates a handful of entries; it is cleared when the workspace is
// closed (documents:clear-open-folders) and on app quit.
import { resolve } from 'node:path'

// Normalize for comparison: absolute, forward-slashed, no trailing slash, lower-cased
// (path case is insignificant on Windows and macOS).
function norm(p: string): string {
  return resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

// Whether `child` is `parent` itself or lives underneath it.
function isInside(child: string, parent: string): boolean {
  const c = norm(child)
  const q = norm(parent)
  return c === q || c.startsWith(q + '/')
}

const openFolders: string[] = []

// Snapshot of the currently watched folders (oldest first). Returned as a copy so
// callers cannot mutate the set behind the watcher's back.
export function getOpenFolders(): string[] {
  return [...openFolders]
}

// Register a folder as watched. Returns false (and changes nothing) when it is
// already covered by a broader folder in the set; otherwise drops any narrower
// entries it makes redundant, appends it and returns true.
export function addOpenFolder(folderPath: string): boolean {
  if (!folderPath) return false
  if (openFolders.some((f) => isInside(folderPath, f))) return false
  for (let i = openFolders.length - 1; i >= 0; i--) {
    if (isInside(openFolders[i], folderPath)) openFolders.splice(i, 1)
  }
  openFolders.push(folderPath)
  return true
}

// Forget every watched folder.
export function clearOpenFolders(): void {
  openFolders.length = 0
}
