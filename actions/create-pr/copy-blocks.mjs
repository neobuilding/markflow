// Build helper: copy the built-in block plugins from `src/blocks/` into
// `dist/blocks/` so the runtime directory scanner can load them after ncc has
// bundled the action. ncc 0.38 has no `--asset` flag, so we copy the files
// explicitly; the loader resolves `dist/blocks` first at runtime.
import { cpSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = join(__dirname, 'src', 'blocks')
const dest = join(__dirname, 'dist', 'blocks')

mkdirSync(dest, { recursive: true })
if (existsSync(src)) {
  cpSync(src, dest, { recursive: true })
  console.log(`create-pr: copied built-in blocks from ${src} -> ${dest}`)
} else {
  console.warn(`create-pr: no built-in blocks found at ${src}; skipping copy`)
}
