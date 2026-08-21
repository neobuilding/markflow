// Block-plugin loader for the "Create / Refresh PR" GitHub Action.
//
// This module is intentionally NOT part of core.mjs: it performs file IO and
// dynamic `import()`, so it carries no coverage threshold (consistent with the
// Action entry point). The pure rendering logic lives in core.mjs
// (`renderBlock` / `discoverSegments` / `fillAutoBlocks`).
//
// Loading model (single, unified mechanism for built-in and user blocks):
//   - Every block is a `*.mjs` file exporting `export default (ctx) => string`.
//   - The file name (minus `.mjs`) is the block name registered in the registry.
//   - Built-in blocks ship inside the action (`src/blocks/` → bundled into
//     `dist/blocks/` as an ncc asset); user blocks live in their repo
//     (default `.github/create-pr/blocks/`, resolved from `process.cwd()`).
//   - Order: built-in registry is loaded first, then the user directory; a user
//     block with the same name overrides a built-in one.
//   - Resilience: a single file that fails to import/run is skipped (treated as
//     a missing block) without aborting the whole run.
import { readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Resolve the built-in blocks directory. When bundled by ncc, this file lives
// at `dist/index.mjs` and the blocks asset is copied next to it at
// `dist/blocks/`; in source form it is `src/loader.mjs` and the blocks are at
// `src/blocks/`. We try both, preferring whichever exists.
export function builtinBlocksDir() {
  const candidates = [
    join(__dirname, 'blocks'), // bundled asset layout (dist/blocks)
    join(__dirname, 'src', 'blocks'), // source layout (actions/create-pr/src/blocks)
  ]
  for (const dir of candidates) {
    if (existsSync(dir)) return dir
  }
  return candidates[0]
}

// Scan a directory of `*.mjs` block plugins and register each by file name.
// Missing/symbolic directories yield an empty registry (never throw). A single
// file that throws on import is skipped (logged) so one bad plugin cannot break
// the run. Returns a `Record<string, (ctx) => string>` registry.
export async function loadBlocks(dir) {
  const registry = {}
  if (!dir || !existsSync(dir)) return registry
  let files
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.mjs'))
  } catch {
    return registry
  }
  for (const file of files) {
    const name = file.replace(/\.mjs$/, '')
    try {
      const mod = await import(pathToFileURL(join(dir, file)).href)
      const fn = mod.default
      if (typeof fn === 'function') {
        registry[name] = fn
      }
    } catch {
      // Skip a plugin that fails to load; rendering will treat it as missing
      // and leave its `{{name}}` placeholder untouched.
    }
  }
  return registry
}

// Build the full block registry: built-in blocks first, then user blocks
// (overriding same-named built-ins). `userDir` is the user's plugin directory
// (default `.github/create-pr/blocks` relative to the repo root / cwd).
export async function buildBlockRegistry(userDir) {
  const builtin = await loadBlocks(builtinBlocksDir())
  const user = await loadBlocks(userDir)
  return { ...builtin, ...user }
}
