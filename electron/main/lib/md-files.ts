// Markdown file-collection helpers, extracted from index.ts.
import { statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import { MD_EXTS } from './markdown-ext'
import { nodeDiskIO, type DiskIO } from './disk-io'

// Re-exported so existing importers (handlers/files.ts, tests) keep one symbol.
export { MD_EXTS }

// Recursively collect all Markdown files under a directory. Filesystem access goes
// through the injected `DiskIO` port (defaults to the real node:fs adapter) so the
// walk is testable against an in-memory fake; see docs/agents/testing.md.
export function collectMarkdownFiles(dir: string, io: DiskIO = nodeDiskIO): string[] {
  const result: string[] = []
  try {
    const entries = io.readdir(dir)
    for (const entry of entries) {
      // Skip hidden directories and node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      if (entry.isDirectory()) {
        result.push(...collectMarkdownFiles(join(dir, entry.name), io))
      } else {
        // Anything that isn't a directory (regular file, symlink, etc.) is matched
        // by its markdown extension.
        const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase()
        if (MD_EXTS.has(ext)) {
          result.push(join(dir, entry.name))
        }
      }
    }
  } catch {
    // Skip directories we can't access
  }
  return result
}

// Extract file/folder paths to open from command-line arguments
// (filtering out Electron's own args, script paths, dev server URLs, etc.).
// Only active in packaged mode; in dev, process.argv is mostly Vite/Electron internal
// args and should not be handled here. Kept as a single-argument signature
// (argv) so call sites (process.argv / second-instance argv) stay unchanged;
// the packaged-mode check reads app.isPackaged directly.
export function extractArgvPaths(argv: string[]): string[] {
  if (!app.isPackaged) return []
  const paths: string[] = []
  for (const arg of argv) {
    if (arg.startsWith('-') || arg.startsWith('http')) continue
    if (arg.endsWith('.js') || arg.endsWith('.ts') || arg.endsWith('.cjs')) continue
    try {
      const absolute = resolve(arg)
      const st = statSync(absolute)
      if (st.isDirectory()) {
        paths.push(absolute)
      } else {
        // Non-directory entries (regular files, symlinks, etc.) are matched by
        // their markdown extension; see collectMarkdownFiles for the rationale.
        const ext = arg.slice(arg.lastIndexOf('.')).toLowerCase()
        if (MD_EXTS.has(ext)) paths.push(absolute)
      }
    } catch {
      // Ignore paths that don't exist
    }
  }
  return paths
}
