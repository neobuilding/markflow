// Version guard for `picomatch` (ADR-0023 D25).
//
// Why this exists: `parsePatterns()` feeds USER-TYPED globs straight into picomatch, so a
// vulnerable picomatch is a ReDoS reachable from the Search view's include/exclude row. D25
// therefore requires the guard to be checked against the version the lockfile actually RESOLVES,
// not against the `^4.0.7` range in `package.json` — a range only says "at install time it was
// fine", and nothing stops a later `npm install` from resolving a downgraded nested copy.
//
// Two things are deliberately NOT asserted:
//  * we do not fail on a missing lockfile entry (a dependency that goes away cannot be vulnerable);
//  * we do not hard-code "the sky is falling" — each major line carries its own recorded floor, so
//    a legitimate 5.x upgrade is not blocked by a 4.x-era number.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// GHSA-3v7f-55p6-f55p (ReDoS in picomatch) is fixed in 4.0.3. The 2.x line is not covered by that
// advisory; its floor is the version currently resolved for `micromatch`'s nested copy, recorded so
// that a silent downgrade of that copy is caught and reviewed rather than shipped.
const MIN_SAFE_BY_MAJOR: Record<string, string> = {
  '2': '2.3.2',
  '4': '4.0.3',
}

interface LockPackage {
  version?: string
}

function resolvedPicomatchVersions(): Array<{ name: string; version: string }> {
  const lockPath = join(process.cwd(), 'package-lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
    packages?: Record<string, LockPackage>
  }
  const out: Array<{ name: string; version: string }> = []
  for (const [name, pkg] of Object.entries(lock.packages ?? {})) {
    if (!/(^|\/)picomatch$/.test(name) || !pkg.version) continue
    out.push({ name, version: pkg.version })
  }
  return out
}

function compare(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

describe('picomatch resolved version (ADR-0023 D25)', () => {
  it('resolves at least one picomatch copy to inspect', () => {
    // Guards the guard: if the lockfile shape ever changes (v2 → v3 → v4), the loop above would
    // silently return nothing and every other assertion would pass vacuously.
    expect(resolvedPicomatchVersions().length).toBeGreaterThan(0)
  })

  it('every resolved picomatch is at or above the safe floor for its major line', () => {
    for (const { name, version } of resolvedPicomatchVersions()) {
      const major = version.split('.')[0]
      const floor = MIN_SAFE_BY_MAJOR[major]
      // An unknown major means picomatch released a new line: stop and record a floor for it
      // rather than letting an unvetted version through.
      expect(floor, `${name} @ ${version} has no recorded safe floor`).toBeTruthy()
      expect(
        compare(version, floor),
        `${name} @ ${version} is below the safe floor ${floor} (GHSA-3v7f-55p6-f55p)`,
      ).toBeGreaterThanOrEqual(0)
    }
  })

  it('the picomatch used by this app is the 4.x line the code is written against', () => {
    const root = resolvedPicomatchVersions().find((p) => p.name === 'node_modules/picomatch')
    expect(root).toBeDefined()
    // `strictBrackets: true` — the option `parsePatterns()` relies on to make an unbalanced `[`
    // detectable — only exists on 4.x.
    expect(root!.version.split('.')[0]).toBe('4')
  })
})
