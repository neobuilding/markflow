// files:resolve-paths handler expand dropped/passed paths into all their .md
// files, filter files by extension, and return de-duplicated directory and
// Markdown file lists. Extracted from index.ts.
import { ipcMain } from 'electron'
import { resolve, dirname } from 'node:path'
import { MD_EXTS, collectMarkdownFiles } from '../lib/md-files'
import { nodeDiskIO, type DiskIO } from '../lib/disk-io'

export function registerFilesHandlers(io: DiskIO = nodeDiskIO): void {
  // Resolve a set of dropped/passed paths: expand folders into all their .md files,
  // filter files by extension, and return de-duplicated directory and Markdown file lists.
  // The renderer uses this to import in one shot and set the "current folder".
  // All filesystem access flows through the injected `io` (the DiskIO port) so the
  // handler is testable against an in-memory fake; see docs/agents/testing.md.
  ipcMain.handle('files:resolve-paths', (_event, paths: string[]) => {
    const directories: string[] = []
    const markdownFiles = new Set<string>()
    for (const p of paths) {
      try {
        const absolute = resolve(p)
        if (io.isDirectory(absolute)) {
          directories.push(absolute)
          for (const f of collectMarkdownFiles(absolute, io)) markdownFiles.add(f)
        } else {
          // isDirectory()===false means a regular file (symlinks resolve to their
          // target). Filter by extension; non-markdown paths add nothing.
          const ext = absolute.slice(absolute.lastIndexOf('.')).toLowerCase()
          if (MD_EXTS.has(ext)) {
            markdownFiles.add(absolute)
            // When opening a single file, also import every .md file in its directory so the
            // sidebar shows sibling documents (not just the one currently open).
            const parentDir = dirname(absolute)
            if (!directories.includes(parentDir)) {
              directories.push(parentDir)
            }
            for (const f of collectMarkdownFiles(parentDir, io)) markdownFiles.add(f)
          }
        }
      } catch {
        // Skip paths we can't access
      }
    }
    return { directories, markdownFiles: [...markdownFiles] }
  })
}
