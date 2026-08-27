// folderMatch.ts — shared path-matching helper for the document store.
//
// Kept in its own module (no module-level singleton state) so it can be imported
// both by `documentStore` and by tests without pulling in the store's Map
// singleton. The renderer has its own equivalent in src/renderer/src/lib/utils.ts;
// the two must stay semantically identical (plan §4 / §6.#9) — changes here should
// be mirrored there.

// Whether a file's directory is inside `folder` (including folder itself);
// case-insensitive (Windows). Mirrors the renderer-side `isInFolder` in
// src/renderer/src/lib/utils.ts. Empty/relative paths yield false.
export function isInFolder(filePath: string, folder: string): boolean {
  if (!folder) return false
  const f = folder.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
  const d = filePath.replace(/\\/g, '/').toLowerCase()
  const idx = d.lastIndexOf('/')
  const dir = idx <= 0 ? '' : d.slice(0, idx)
  return dir === f || dir.startsWith(f + '/')
}
