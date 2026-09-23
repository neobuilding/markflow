// @vitest-environment node
//
// Guard test (not a helper): e2e specs and helpers must be SELF-CONTAINED — they read
// test data from `e2e/fixtures/`, never from the `examples/` tree at runtime. The
// `examples/` directory holds human-facing demo material that changes for product
// reasons, not for test reasons; a spec that depends on it can break (or silently
// pass against stale data) when the demo is edited. A spec MAY mention an upstream
// source inside a comment (e.g. "self-contained copy of examples/demo.en.md") for
// traceability — but that mention must live in a comment, never in a runtime path.
//
// This test strips block comments, line comments, and scheme:// URLs, then fails if
// the literal path segment `examples/` still appears: that means a spec reads from
// examples at runtime. (Guarded here so the rule in AGENTS.md cannot silently regress.)
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')
const E2E_DIR = join(REPO_ROOT, 'e2e')

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collectSources(full, out)
    else if (/\.(ts|tsx)$/.test(full)) out.push(full)
  }
  return out
}

/** Drop block comments, line comments, and scheme:// URLs so only real code remains. */
function stripNonCode(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\b\w+:\/\/\S+/g, '')
}

describe('e2e specs do not depend on the examples/ tree at runtime', () => {
  it('read test data only from e2e/fixtures/', () => {
    const offenders: string[] = []
    for (const file of collectSources(E2E_DIR)) {
      const code = stripNonCode(readFileSync(file, 'utf-8'))
      if (/examples\//.test(code)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })
})
