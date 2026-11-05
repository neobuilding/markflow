// Guard test: the e2e parallelism contract must not drift.
//
// Parallelising the e2e suite is only safe because of a few facts that live in the CONFIG, and none
// of them is visible from a failing test — they surface as "the clipboard got stomped" or "the perf
// gate went red for no reason", i.e. as flaky noise nobody can point at:
//
//   1. The clipboard / perf projects are capped at ONE worker. They write the REAL system clipboard
//      and assert hard timing thresholds; two of their specs running at once would corrupt both.
//      `workers: 1` per project is what prevents that, and the whole point of the project split
//      (see e2e/guards/clipboard-project.test.ts) is that the destructive specs live in their own
//      project. Drop the cap and the suite gets faster — and starts eating the user's clipboard.
//   2. `e2e-app` has NO project-level cap, so it inherits the global adaptive budget. A cap here
//      would silently turn the whole speedup back into a serial run.
//   3. The global budget is COMPUTED from the machine, not hardcoded to 1 — otherwise the suite
//      stays serial and nobody notices, because a serial suite still passes.
//
// The CI workflow is the other half of the contract, and it is plain text in ANOTHER file, which is
// exactly why it needs a test rather than a code review:
//   4. No CI step passes `--workers`. The worker count is owned by playwright.config.ts; a
//      `--workers=2` in the workflow would be a second, hardcoded copy of a number nobody
//      re-validates when the config changes.
//   5. CI selects exactly the projects `npm run e2e:full` selects. Those two lists describe the
//      same intent but live in two files (the workflow and package.json), so adding a project to one
//      and forgetting the other would silently drop a suite from local runs, from CI, or from both.
//   6. The perf gate runs in its OWN playwright invocation. `workers: 1` only caps concurrency
//      WITHIN a project: Playwright schedules the projects of one invocation concurrently, so a
//      gate sharing an invocation with e2e-app is timed on a loaded machine.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import config from '../../playwright.config'

// The repo root, derived from THIS file's location (the same convention as e2e/helpers/launch.ts
// and the other guards), so the guard reads the same sources no matter where the run started.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const repoSource = (relPath: string): string => readFileSync(join(ROOT, relPath), 'utf-8')

const projects = config.projects ?? []
const projectOf = (name: string) => projects.find((p) => p.name === name)

/** The projects that must run one-at-a-time, whatever the global budget says. */
const SERIAL_PROJECTS = ['e2e-clipboard', 'e2e-perf-gate', 'e2e-perf-diag']

/** The project that must NOT be capped — it is the one that parallelises. */
const PARALLEL_PROJECT = 'e2e-app'

/**
 * The workflow's Playwright invocations, with comment lines dropped: a commented-out command must
 * not count as "the workflow runs this project".
 */
function workflowPlaywrightLines(): string[] {
  return repoSource('.github/workflows/ci.yml')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .filter((line) => line.includes('playwright test'))
}

/** The project names a Playwright command selects. */
function projectsIn(command: string): string[] {
  return [...command.matchAll(/--project=(\S+)/g)].map((m) => m[1])
}

describe('the e2e parallelism contract', () => {
  it('caps the destructive and timing-sensitive projects at one worker each', () => {
    for (const name of SERIAL_PROJECTS) {
      expect(projectOf(name)?.workers, name + ' must run with workers: 1').toBe(1)
    }
  })

  it('gives e2e-app the global adaptive budget (no project-level cap)', () => {
    // A cap here would silently turn the parallel suite back into a serial one: the speedup would
    // vanish with no failing test to point at it.
    expect(projectOf(PARALLEL_PROJECT)?.workers).toBeUndefined()
  })

  it('keeps the global budget a sane number', () => {
    expect(typeof config.workers).toBe('number')
    expect(config.workers as number).toBeGreaterThanOrEqual(1)
  })

  it('derives the global budget from the machine instead of hardcoding it', () => {
    // `workers: 1` at the top level is the pre-ADR-0027 state: a serial suite that still passes,
    // so the regression would be invisible until someone measured the wall clock again.
    const source = repoSource('playwright.config.ts')
    expect(source).toMatch(/^ {2}workers:\s*Math\./m)
    // `availableParallelism()` honours the cgroup CPU quota / affinity mask; `cpus().length`
    // reports the HOST's cores and over-subscribes a limited runner.
    expect(source).toContain('availableParallelism()')
  })

  it('keeps tests inside a file serial, and parallelises across files', () => {
    // fullyParallel:false is the shape the budget relies on: one file = one worker = ordered tests,
    // while different files run on different workers.
    expect(config.fullyParallel).toBe(false)
  })

  it('never lets the CI workflow override the worker budget', () => {
    const commands = workflowPlaywrightLines()
    expect(commands.length).toBeGreaterThan(0)
    const offenders = commands.filter((line) => /--workers\b/.test(line))
    expect(offenders).toEqual([])
  })

  it('runs exactly the projects npm run e2e:full runs', () => {
    const pkg = JSON.parse(repoSource('package.json')) as { scripts: Record<string, string> }
    const inScript = projectsIn(pkg.scripts['e2e:full'] ?? '')
    const inWorkflow = [...new Set(workflowPlaywrightLines().flatMap(projectsIn))].sort()
    expect(inWorkflow).toEqual([...new Set(inScript)].sort())
  })

  it('gives the timing-sensitive perf gate its OWN playwright invocation', () => {
    // Playwright schedules the projects of ONE invocation CONCURRENTLY (measured 2026-11-05:
    // three specs in two projects ran on three workers and finished in 12.7s of wall clock while
    // their own durations summed to 21.1s). A perf gate that shares an invocation with e2e-app
    // is therefore measured on a loaded machine: firstContentMs measured 1602ms against the
    // 1500ms threshold → RED, while the SAME build measured 712ms in its own invocation
    // (478/541/647 across idle runs).
    //
    // The threshold must NOT be relaxed to compensate — the app is ~3x faster than the frozen
    // 2644ms baseline — and nothing in a failing test would point at the cause, so the
    // isolation is pinned here.
    const pkg = JSON.parse(repoSource('package.json')) as { scripts: Record<string, string> }
    const invocations = (pkg.scripts['e2e:full'] ?? '')
      .split('&&')
      .map((command) => command.trim())
      .filter(Boolean)
    const perfInvocations = invocations.filter((command) =>
      projectsIn(command).includes('e2e-perf-gate'),
    )
    expect(perfInvocations).toHaveLength(1)
    expect(projectsIn(perfInvocations[0])).not.toContain(PARALLEL_PROJECT)

    // CI must do the same: the perf gate gets a step of its own, sharing no invocation with
    // the app shards or the clipboard specs.
    const perfSteps = workflowPlaywrightLines().filter((line) =>
      projectsIn(line).includes('e2e-perf-gate'),
    )
    expect(perfSteps).toHaveLength(1)
    expect(projectsIn(perfSteps[0])).not.toContain(PARALLEL_PROJECT)
    expect(projectsIn(perfSteps[0])).not.toContain('e2e-clipboard')
  })

  it('keeps the diagnostic perf project out of CI and out of e2e:full', () => {
    // e2e-perf-diag is the on-demand twin of e2e-perf-gate: no thresholds, slow by design. It is
    // run by hand (`npm run e2e:perf-diag`), never by the suite CI runs.
    const pkg = JSON.parse(repoSource('package.json')) as { scripts: Record<string, string> }
    const inScript = projectsIn(pkg.scripts['e2e:full'] ?? '')
    const inWorkflow = workflowPlaywrightLines().flatMap(projectsIn)
    for (const name of ['e2e-perf-diag']) {
      expect(inScript).not.toContain(name)
      expect(inWorkflow).not.toContain(name)
    }
  })
})
