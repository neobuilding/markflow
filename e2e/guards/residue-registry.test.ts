// Contract guard for the three bookkeeping claims in ADR-0036 §2. Each is a
// single line in a DIFFERENT file; losing one is silent (the gate would audit stale
// entries, pass vacuously after a retry, or commit harness state as source), so the
// wiring is pinned here as a narrow extraction from the source text. The behaviour
// of the wipe / write / read functions themselves is unit-tested in temp.test.ts.
import { describe, it, expect } from 'vitest'
import { repoSource } from './repo'

/**
 * Does a .gitignore body ignore the residue registry? Split on BOTH line endings:
 * a Windows checkout with `core.autocrlf=true` yields CRLF, and a `$`-anchored regex
 * would then go red on Windows while staying green on Linux CI. Exported so this
 * cross-platform behaviour is pinned by a unit test, not by whichever host runs it.
 */
export function ignoresResidueRegistry(ignore: string): boolean {
  return ignore.split(/\r?\n/).some((line) => line.trim() === 'e2e/.residue-registry/')
}

describe('ADR-0036: run-scoped residue registry bookkeeping', () => {
  it('wipes the previous run at the START of global-setup', () => {
    const setup = repoSource('e2e/global-setup.ts')
    expect(setup, 'global-setup must own the once-per-run registry wipe').toMatch(
      /resetResidueRegistry\(\)/,
    )
  })

  it('never lets the gate delete the registry it reads', () => {
    // Deleting it mid-run races a still-running worker's recordAllocation; a retry
    // would then face empty bookkeeping and pass green (ADR-0036 §2/§3).
    const gate = repoSource('e2e/residue-gate/residue-gate.e2e.spec.ts')
    expect(gate, 'the gate must only clean up leaked PATHS, not the registry').not.toMatch(
      /\b(rmSync|unlinkSync|resetResidueRegistry)\b/,
    )
    expect(gate).toMatch(/cleanupResidue\(leftovers\)/)
  })

  it('keeps the registry git-ignored (harness bookkeeping, never source)', () => {
    const ignore = repoSource('.gitignore')
    expect(
      ignoresResidueRegistry(ignore),
      '.gitignore must ignore e2e/.residue-registry/ (harness state is never source)',
    ).toBe(true)
  })

  it('detects the ignore rule on LF and CRLF checkouts, and rejects a stale rule', () => {
    // Contract guards must stay deterministic across Windows and Linux CI
    // (docs/agents/testing.md). A `$`-anchored regex silently went blind to CRLF.
    expect(ignoresResidueRegistry('node_modules/\r\ne2e/.residue-registry/\r\n')).toBe(true)
    expect(ignoresResidueRegistry('node_modules/\ne2e/.residue-registry/\n')).toBe(true)
    expect(ignoresResidueRegistry('node_modules/\r\ne2e/.residue-registry-old/\r\n')).toBe(false)
  })
})
