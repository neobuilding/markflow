// @vitest-environment node
//
// Guard test (not a helper): no production IPC handler in `electron/main/handlers/`
// may import `node:fs` directly. The DiskIO port (`electron/main/lib/disk-io.ts`)
// is the single sanctioned seam for filesystem I/O (see docs/agents/testing.md,
// "Filesystem access goes through the DiskIO port"): handlers are ORCHESTRATION and
// must take `io: DiskIO` as a parameter (with a `nodeDiskIO` default) so unit tests
// can inject an in-memory fake. Importing `node:fs` straight from a handler bypasses
// that seam and silently makes the handler untestable against a fake.
//
// This guard watches the whole `handlers/` directory so a NEW handler cannot repeat
// the `app.ts` regression that this rule was written to prevent.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')
const SELF = fileURLToPath(import.meta.url)
const HANDLERS_DIR = join(REPO_ROOT, 'electron', 'main', 'handlers')

const IMPORT_RE =
  /(?:from\s+['"]node:fs(?:\/promises)?['"]|import\s+['"]node:fs(?:\/promises)?['"]|import\(\s*['"]node:fs(?:\/promises)?['"]\s*\)|require\(\s*['"]node:fs(?:\/promises)?['"]\s*\))/

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collectSources(full, out)
    else if (/\.(ts|tsx)$/.test(full)) out.push(full)
  }
  return out
}

describe('handlers route filesystem I/O through the DiskIO port', () => {
  it('import no node:fs directly', () => {
    const offenders: string[] = []
    for (const file of collectSources(HANDLERS_DIR)) {
      if (file === SELF) continue
      if (/\.test\.tsx?$/.test(file)) continue
      const text = readFileSync(file, 'utf-8')
      if (IMPORT_RE.test(text)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })
})
