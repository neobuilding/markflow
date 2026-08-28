// Markdown extension helpers.
//
// Kept in its own electron-free module so both the main-process IPC layer, the
// file-collection helpers (lib/md-files.ts) and the folder watcher
// (model/folderWatcher.ts) can share one definition without dragging the
// `electron` import (which md-files.ts needs for `app.isPackaged`) into
// modules that must stay importable under the unit-test runner.
import { extname } from 'node:path'

// Supported Markdown extensions.
export const MD_EXTS = new Set(['.md', '.markdown', '.mdx', '.mdtxt', '.mdtext'])

// Whether a path points at a Markdown file, judged by its extension (case-insensitive).
// Used by the folder watcher to filter filesystem events down to Markdown files.
export function isMarkdownFile(filePath: string): boolean {
  return MD_EXTS.has(extname(filePath).toLowerCase())
}

// Drop the Markdown extension from a file name to derive a display title.
// The single place that knows the extension list, so that adding an extension to
// MD_EXTS cannot leave a stray extension in document titles (the alternative — a
// hardcoded regex at each call site — drifts out of sync silently).
// Non-Markdown names are returned untouched, so callers need no guard.
export function stripMarkdownExt(fileName: string): string {
  const ext = extname(fileName).toLowerCase()
  if (!MD_EXTS.has(ext)) return fileName
  return fileName.slice(0, -ext.length)
}
