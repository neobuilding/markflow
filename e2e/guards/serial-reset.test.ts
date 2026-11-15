// Contract guard: ADR-0035 Consequences / docs/agents/testing.md require every spec
// using the serial (shared-instance) pattern to call resetAppState in each
// beforeEach. The failure is quiet: a case that sets main-process confirm spies or
// leaves a draft behind makes a LATER case pass vacuously (a stale recorder satisfies
// `.poll(calls.length).toBeGreaterThan(0)`), and no e2e run reports the leak itself.
//
// Derivation, not a file allowlist: a new serial spec is picked up automatically,
// and every beforeEach in it is checked. A zero-iteration loop is a vacuous green,
// so both the spec set and each file's beforeEach set carry explicit expectations.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { specFilesUnder } from './scan-specs'
import { ROOT } from './repo'

const E2E_ROOT = join(ROOT, 'e2e')
const SERIAL_MODE_RE = /test\.describe\.configure\(\{\s*mode:\s*'serial'\s*\}\)/

/** The body of every `test.beforeEach(async () => { ... })` in a spec. */
function beforeEachBlocks(source: string): string[] {
  return [
    ...source.matchAll(/test\.beforeEach\(\s*async\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\}\)/g),
  ].map((match) => match[1])
}

describe('ADR-0035: serial specs reset shared app state', () => {
  it('calls resetAppState in EVERY beforeEach of every serial spec', () => {
    const specs = specFilesUnder(E2E_ROOT)
    expect(specs.length, 'the scan must find e2e specs').toBeGreaterThan(0)
    const serialSpecs = specs.filter((file) => SERIAL_MODE_RE.test(readFileSync(file, 'utf-8')))
    expect(serialSpecs.length, 'the scan must find at least one serial spec').toBeGreaterThan(0)

    for (const file of serialSpecs) {
      const name = relative(ROOT, file)
      const source = readFileSync(file, 'utf-8')
      expect(source, `${name} must import resetAppState from ../helpers/reset`).toMatch(
        /from\s+['"]\.\.\/helpers\/reset['"]/,
      )
      const blocks = beforeEachBlocks(source)
      expect(blocks.length, `${name} declares serial mode but has no beforeEach`).toBeGreaterThan(0)
      for (const block of blocks) {
        expect(
          block,
          `${name}: a serial beforeEach must reset both processes before the next case`,
        ).toMatch(/await\s+resetAppState\(\s*handle\s*\)/)
      }
    }
  })
})
