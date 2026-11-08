// Contract guard, not a behaviour test: these assertions lock repository conventions
// (calibrated thresholds, CI orchestration) rather than application logic.
//
// Guard test: the performance-gate contract must not drift.
//
// Two things here are load-bearing, and NEITHER is visible from a failing perf run:
//
//  1. The five large-document thresholds. They are the CI gate's whole content and they were
//     calibrated against a frozen baseline. Relaxing one to "make CI green" is exactly the failure
//     mode ADR-0027 forbids ("the fix belongs in the code"), and nothing in the suite would object:
//     the gate would simply get slower at catching regressions, one number at a time. The numbers
//     are therefore pinned here, together with the env-var names that are their only sanctioned
//     override — an ad-hoc run may loosen a threshold, a commit may not.
//
//  2. The arrangement ADR-0034 introduced: the CI workflow selects projects BY NAME and must not
//     carry a spec path (a path in the workflow is a second source of truth that goes stale the
//     moment a directory is renamed), and `e2e:full` must keep its two invocations so the timing
//     gate never shares a machine with the app specs.
import { describe, it, expect } from 'vitest'
import { e2eFullInvocations, playwrightCommandsIn, repoSource } from './repo'

const GATE_SPEC = 'e2e/perf-gate/large-doc-perf.e2e.spec.ts'

/**
 * POLICY constants, not implementation snapshots. The expected values come from the ADR-0027
 * calibration table and the 2026-09-20 frozen baseline (e2e/perf-baselines/large-doc.json), and
 * ADR-0027 explicitly forbids relaxing a threshold to make a red CI run green. They therefore
 * have an independent correctness oracle and belong here — deleting them would leave "a gate that
 * got slower at catching regressions" with no failing test.
 */
const THRESHOLDS: Array<[constant: string, envVar: string, value: number]> = [
  ['MAX_FIRST_CONTENT_MS', 'PERF_MAX_FIRST_CONTENT_MS', 1500],
  ['MAX_TYPE_TO_PREVIEW_MS', 'PERF_MAX_TYPE_TO_PREVIEW_MS', 2000],
  ['MAX_TYPE_CHAR_MS', 'PERF_MAX_TYPE_CHAR_MS', 2000],
  ['MAX_CLS', 'PERF_MAX_CLS', 0.05],
  ['MAX_MERMAID_RENDERED', 'PERF_MAX_MERMAID_RENDERED', 20],
]

/** Read the declared default out of the gate spec, rather than string-matching a whole line. */
function declaredDefault(source: string, constant: string, envVar: string): number | undefined {
  const match = new RegExp(
    `const ${constant}\\s*=\\s*Number\\(process\\.env\\.${envVar}\\s*\\?\\?\\s*([\\d.]+)\\)`,
  ).exec(source)
  return match ? Number(match[1]) : undefined
}

/**
 * Is this constant the ARGUMENT of a comparison?
 *
 * The constant appears in `.toBeLessThan(MAX_CLS)`, not inside `expect(...)` — so the first version
 * of this check ("`expect(` within the preceding 200 characters") was satisfied by a message string
 * that merely mentioned the constant, e.g. `expect(x, 'MAX_CLS is too high')`. That would stay
 * green while the constant became decorative. Matching the comparison argument is what the name
 * claims, and it tolerates the multi-line call shape the gate actually uses.
 */
function isAsserted(source: string, constant: string): boolean {
  const comparison = new RegExp(
    `\\b(?:toBeLessThan|toBeGreaterThan|toBeLessThanOrEqual|toBeGreaterThanOrEqual|toBe|toEqual)` +
      `\\s*\\(\\s*${constant}\\b`,
  )
  return comparison.test(source)
}

describe('the performance gate contract', () => {
  it('pins the five calibrated thresholds and the env var that overrides each', () => {
    const spec = repoSource(GATE_SPEC)
    for (const [constant, envVar, value] of THRESHOLDS) {
      expect(
        declaredDefault(spec, constant, envVar),
        `ADR-0027: ${constant} must stay at ${value} (calibrated against the 2026-09-20 frozen ` +
          `baseline) and be overridable only via ${envVar}. A red gate is fixed in the CODE, ` +
          `never by relaxing this number.`,
      ).toBe(value)
    }
  })

  it('asserts every threshold in the gate, so a constant cannot become decorative', () => {
    const spec = repoSource(GATE_SPEC)
    for (const [constant] of THRESHOLDS) {
      expect(isAsserted(spec, constant), `${constant} is never asserted`).toBe(true)
    }
  })

  it('keeps every CI invocation project-selected, never path-selected or narrowed', () => {
    // The workflow selects projects by name; a path there is a second source of truth that goes
    // stale the moment a directory is renamed — and nothing would fail until the suite silently
    // stopped running (ADR-0034 Decision 4).
    //
    // The first version of this check matched the OLD directory names (`e2e/specs/`, `e2e/perf/`)
    // only. After the ADR-0034 rename it could never match again, so it passed no matter what the
    // workflow said — a regression test that cannot fail. It now inspects each command's argv.
    const commands = playwrightCommandsIn(repoSource('.github/workflows/ci.yml'))
    expect(commands.length, 'the CI workflow must actually run playwright').toBeGreaterThan(0)
    for (const command of commands) {
      expect(
        command,
        'ADR-0034 Decision 4: select projects by name, never by spec path or project directory',
      ).not.toMatch(/\.e2e\.spec\.ts|e2e\/(app|clipboard|perf-gate|perf-diag)\b/)
      expect(
        command,
        '--grep / --only would silently narrow the full run, making the gate a formality',
      ).not.toMatch(/--grep\b|--only\b|(?:^|\s)-g\s/)
      expect(command, 'every CI invocation must name its project explicitly').toMatch(/--project=/)
    }
  })

  it('keeps the CI combination at two invocations, with the gate alone in the second', () => {
    // Two invocations, not one: Playwright schedules the projects of ONE invocation concurrently,
    // so a shared machine is what made the gate measure 1602ms against a 1500ms threshold
    // (ADR-0027, e2e/guards/e2e-parallelism.test.ts).
    const invocations = e2eFullInvocations()
    expect(invocations).toHaveLength(2)
    expect(invocations[0]).toContain('--project=e2e-app')
    expect(invocations[0]).toContain('--project=e2e-clipboard')
    expect(invocations[1]).toContain('--project=e2e-perf-gate')
    expect(invocations[1]).not.toContain('--project=e2e-app')
  })

  it('persists the run record before asserting a single threshold', () => {
    // ADR-0034 "Invariants that must not change": a red gate must still leave its numbers on disk
    // to diff against. Asserting first is the one ordering a failing run hides.
    const spec = repoSource(GATE_SPEC)
    const persistedAt = spec.indexOf('writeRunRecord(')
    const firstGate = spec.indexOf('toBeLessThan(MAX_')
    expect(persistedAt, 'the gate must call writeRunRecord').toBeGreaterThan(0)
    expect(firstGate, 'the gate must assert the calibrated thresholds').toBeGreaterThan(0)
    expect(
      persistedAt,
      'ADR-0034: persist the report BEFORE the first threshold assertion',
    ).toBeLessThan(firstGate)
  })

  it('keeps the frozen baseline intact', () => {
    // The baseline is the oracle the five thresholds were calibrated from; editing it to make a
    // regression look small is the same failure as relaxing a threshold, one file further away.
    const baseline = JSON.parse(repoSource('e2e/perf-baselines/large-doc.json')) as {
      frozenAt?: string
      commit?: string
      metrics?: Record<string, number>
    }
    expect(baseline.frozenAt, 'ADR-0034: the 2026-09-20 freeze must not be re-recorded').toBe(
      '2026-09-20T08:30:05.405Z',
    )
    expect(baseline.commit).toBe('52682270')
    expect(baseline.metrics?.firstContentMs, 'the frozen first-content measurement').toBe(2644)
    for (const key of ['typeToPreviewMs', 'typeCharToPreviewMs', 'cls', 'mermaidRendered']) {
      expect(typeof baseline.metrics?.[key], `missing frozen metric ${key}`).toBe('number')
    }
  })
})
