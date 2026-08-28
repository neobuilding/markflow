// Markdown file-collection helpers, extracted from index.ts.
import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import { MD_EXTS } from './markdown-ext'

// Re-exported so existing importers (handlers/files.ts, tests) keep one symbol.
export { MD_EXTS }

// Recursively collect all Markdown files under a directory
export function collectMarkdownFiles(dir: string): string[] {
  const result: string[] = []
  try {
    const entries = readdirSync(dir)
    for (const name of entries) {
      // Skip hidden directories and node_modules
      if (name.startsWith('.') || name === 'node_modules') continue
      const fullPath = join(dir, name)
      try {
        const st = statSync(fullPath)
        if (st.isDirectory()) {
          result.push(...collectMarkdownFiles(fullPath))
        } else {
          // Anything that isn't a directory (regular file, symlink, etc.) is
          // matched by its markdown extension. Using `else` (rather than
          // `else if (st.isFile())`) keeps the file branch reachable for
          // non-regular entries like symlinks while still skipping directories.
          const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
          if (MD_EXTS.has(ext)) {
            result.push(fullPath)
          }
        }
      } catch {
        // Skip files we can't access
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
