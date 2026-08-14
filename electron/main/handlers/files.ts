// files:resolve-paths handler — expand dropped/passed paths into all their .md
// files, filter files by extension, and return de-duplicated directory and
// Markdown file lists. Extracted from index.ts.
import { ipcMain } from 'electron'
import { resolve, dirname } from 'node:path'
import { statSync } from 'node:fs'
import { MD_EXTS, collectMarkdownFiles } from '../lib/md-files'

export function registerFilesHandlers(): void {
  // Resolve a set of dropped/passed paths: expand folders into all their .md files,
  // filter files by extension, and return de-duplicated directory and Markdown file lists.
  // The renderer uses this to import in one shot and set the "current folder".
  ipcMain.handle('files:resolve-paths', (_event, paths: string[]) => {
    const directories: string[] = []
    const markdownFiles = new Set<string>()
    for (const p of paths) {
      try {
        const absolute = resolve(p)
        const st = statSync(absolute)
        if (st.isDirectory()) {
          directories.push(absolute)
          for (const f of collectMarkdownFiles(absolute)) markdownFiles.add(f)
        } else if (st.isFile()) {
          const ext = absolute.slice(absolute.lastIndexOf('.')).toLowerCase()
          if (MD_EXTS.has(ext)) {
            markdownFiles.add(absolute)
            // When opening a single file, also import every .md file in its directory so the
            // sidebar shows sibling documents (not just the one currently open).
            const parentDir = dirname(absolute)
            if (!directories.includes(parentDir)) {
              directories.push(parentDir)
            }
            for (const f of collectMarkdownFiles(parentDir)) markdownFiles.add(f)
          }
        }
      } catch {
        // Skip paths we can't access
      }
    }
    return { directories, markdownFiles: [...markdownFiles] }
  })
}
