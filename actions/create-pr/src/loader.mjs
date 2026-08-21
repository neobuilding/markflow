// Block-plugin loader for the "Create / Refresh PR" GitHub Action.
//
// This module is intentionally NOT part of core.mjs: it performs file IO and
// dynamic import(), so it carries no coverage threshold (consistent with the
// Action entry point). The pure rendering logic lives in core.mjs
// (`renderBlock` / `discoverSegments` / `fillAutoBlocks`).
//
// Loading model:
//   - Built-in blocks (`title` / `issue` / `commits`) are imported statically
//     so they are bundled into `dist/index.mjs` by ncc. Relying on ncc to copy
//     `src/blocks/` as assets does not work because ncc 0.38 has no `--asset`
//     flag and, more importantly, it replaces runtime `import()` with an empty
//     webpack async context that always throws `MODULE_NOT_FOUND`.
//   - User blocks are `*.mjs` files in `.github/create-pr/blocks/` (or the
//     `blocks-dir` input). They are loaded with a real Node dynamic import
//     obtained via `new Function('url', 'return import(url)')`, which bypasses
//     ncc's static analysis and correctly resolves `file://` URLs at runtime.
//   - The file name (minus `.mjs`) is the block name registered in the registry.
//   - User blocks are merged on top of built-ins, so a same-named user file
//     overrides a built-in.
//   - Resilience: a single file that fails to import/run is skipped (logged)
//     without aborting the whole run.
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import titleBlock from './blocks/title.mjs'
import issueBlock from './blocks/issue.mjs'
import commitsBlock from './blocks/commits.mjs'

// Use a real Node.js ESM dynamic import for user block plugins. The
// `/* webpackIgnore: true */` comment tells ncc/webpack not to create its
// "empty async context" for this call; without it, ncc 0.38 replaces the
// runtime `import()` with a helper that always throws `MODULE_NOT_FOUND`,
// which is exactly the bug that caused all `{{placeholder}}` tokens to be
// left untouched. With the comment, the bundled code keeps the native
// `import()` and correctly resolves `file://` URLs at runtime.
const loadModule = (url) => import(/* webpackIgnore: true */ url)

// Built-in block registry. These plugins ship with the action and are always
// available; they are statically imported so ncc bundles them into dist/index.mjs.
export function builtinRegistry() {
  return {
    title: titleBlock,
    issue: issueBlock,
    commits: commitsBlock,
  }
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
      const url = pathToFileURL(join(dir, file)).href
      const mod = await loadModule(url)
      const fn = mod.default
      if (typeof fn === 'function') {
        registry[name] = fn
      } else {
        console.warn(`create-pr: block plugin "${file}" has no default export; skipping`)
      }
    } catch (err) {
      // Skip a plugin that fails to load; rendering will treat it as missing
      // and leave its `{{name}}` placeholder untouched.
      const detail = err && (err.message || String(err))
      console.warn(`create-pr: failed to load block plugin "${file}": ${detail}`)
    }
  }
  return registry
}

// Build the full block registry: built-in blocks first, then user blocks
// (overriding same-named built-ins). `userDir` is the user's plugin directory
// (default `.github/create-pr/blocks` relative to the repo root / cwd).
export async function buildBlockRegistry(userDir) {
  const builtin = builtinRegistry()
  const user = await loadBlocks(userDir)
  return { ...builtin, ...user }
}
