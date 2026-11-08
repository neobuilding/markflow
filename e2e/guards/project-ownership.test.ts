// Contract guard, not a behaviour test: these assertions lock repository conventions (which
// directory belongs to which project, what shape those directories may contain) rather than
// application logic.
//
// Guard test: ADR-0034 — every e2e spec file belongs to exactly one Playwright project.
//
// The failure this prevents is quiet: with a shared `testDir`, a nested directory, or a
// project-level `testMatch` pointing at another project's files, one spec silently runs twice —
// or a destructive clipboard spec lands in `npm run e2e:app`. Nothing fails; the run just gets
// slower or starts overwriting the user's clipboard.
//
// The directory IS the ownership boundary. This guard is the executable form of "one spec file, one
// project"; it must go red if a spec is duplicated, orphaned, nested, or collected by two projects.
//
// The central assertion is the INVENTORY invariant rather than a head-count:
//
//     every `*.e2e.spec.ts` in the repository is collected by EXACTLY ONE project
//
// It catches a file no project collects (orphaned into `e2e/` root or a leftover directory), and it
// keeps working when specs are added or removed, which a hard-coded total does not. DOUBLE
// collection is excluded structurally, not by this assertion: the four `testDir`s must be disjoint
// and non-nested, and no project may set a `testMatch`. A spec COPIED into a second directory is a
// new, independently collected file — that is what the clipboard exact-coverage check notices.
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative, resolve, isAbsolute } from 'node:path'
import config from '../../playwright.config'
import { specFilesUnder, strayTestFilesUnder } from './scan-specs'
import { ROOT, globToRegExp } from './repo'

const E2E_ROOT = join(ROOT, 'e2e')
const PROJECT_NAMES = ['e2e-app', 'e2e-clipboard', 'e2e-perf-gate', 'e2e-perf-diag'] as const
type ProjectName = (typeof PROJECT_NAMES)[number]

function testDirOf(name: string): string {
  const project = config.projects?.find((p) => p.name === name)
  if (!project) throw new Error(`playwright.config.ts must define the ${name} project`)
  if (typeof project.testDir !== 'string') {
    throw new Error(`${name} must declare its own testDir (ADR-0034)`)
  }
  return project.testDir
}

/** True when `child` is `parent` itself or lives underneath it. */
function contains(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Does this testMatch pattern pick up ONLY `<name>.e2e.spec.ts`? A global filter that also matched
 * `*.test.ts` would quietly widen the collection; the check is semantic on purpose, so adding an
 * explicit extension filter later is allowed while widening it is not.
 */
function matchesOnlyE2eSpecs(pattern: string | RegExp): boolean {
  // A string pattern is a GLOB in Playwright, not a regex. `new RegExp('**/*.e2e.spec.ts')` throws
  // `Nothing to repeat`, so the legal "add an explicit extension filter" case would have crashed
  // the guard instead of passing it.
  const re =
    typeof pattern === 'string'
      ? globToRegExp(pattern)
      : new RegExp(pattern.source, pattern.flags.replace('g', ''))
  return (
    re.test('probe.e2e.spec.ts') &&
    !re.test('probe.test.ts') &&
    !re.test('probe.spec.ts') &&
    !re.test('probe.ts')
  )
}

const dirs = Object.fromEntries(PROJECT_NAMES.map((name) => [name, testDirOf(name)])) as Record<
  ProjectName,
  string
>
const filesByProject = Object.fromEntries(
  PROJECT_NAMES.map((name) => [name, specFilesUnder(dirs[name])]),
) as Record<ProjectName, string[]>
const collected = PROJECT_NAMES.flatMap((name) => filesByProject[name])
const has = (name: ProjectName, basename: string): boolean =>
  filesByProject[name].some((file) => file.endsWith(basename))

describe('ADR-0034: one e2e spec file, one project', () => {
  it('leaves the global testDir unset, so every project must declare its own', () => {
    // A global testDir would be a second, shared root: a project that forgot its own would
    // silently scan the whole e2e tree and re-collect its neighbours' files.
    expect(config.testDir).toBeUndefined()
  })

  it('lets no project set its own testMatch, so the directory stays the only boundary', () => {
    // A project-level testMatch is how the old arrangement worked: several projects pointed at one
    // directory and split the files by name. That is exactly the "second boundary" ADR-0034 removed
    // — with it, "which project owns this file" stops being answerable from the layout.
    expect((config.projects ?? []).length, 'the project list must not be empty').toBeGreaterThan(0)
    for (const project of config.projects ?? []) {
      expect(
        project.testMatch,
        `${project.name} must not reintroduce a testMatch filter`,
      ).toBeUndefined()
    }
  })

  it('keeps any global testMatch an extension filter, never a second boundary', () => {
    const global = config.testMatch
    const patterns = global === undefined ? [] : Array.isArray(global) ? global : [global]
    if (patterns.length === 0) {
      // The narrowest arrangement, and what this config relies on today. Asserting the ABSENCE is
      // the point: looping over an empty list would pass without checking anything — the vacuous
      // green this very file rejects elsewhere with `toBeGreaterThan(0)`.
      expect(global, 'testMatch must be absent, not an empty array').toBeUndefined()
      return
    }
    for (const pattern of patterns) {
      expect(
        matchesOnlyE2eSpecs(pattern),
        'a global testMatch may only select the .e2e.spec.ts extension',
      ).toBe(true)
    }
  })

  it('defines exactly the four projects, each with its own distinct testDir', () => {
    expect((config.projects ?? []).map((p) => p.name).sort()).toEqual([...PROJECT_NAMES].sort())
    expect(new Set(Object.values(dirs)).size).toBe(PROJECT_NAMES.length)
  })

  it('points every testDir at a directory that exists', () => {
    // A testDir that no longer exists makes `readdirSync` throw — red, but with an ENOENT stack
    // instead of a sentence that names the mistake.
    for (const name of PROJECT_NAMES) {
      expect(existsSync(dirs[name]), `${name} points at a missing directory: ${dirs[name]}`).toBe(
        true,
      )
    }
  })

  it('keeps the four testDirs disjoint and non-nested', () => {
    for (const a of PROJECT_NAMES) {
      for (const b of PROJECT_NAMES) {
        if (a === b) continue
        expect(contains(dirs[a], dirs[b]), `${a} must not contain ${b}`).toBe(false)
      }
    }
  })

  it('collects every spec file in the repository exactly once', () => {
    // The inventory invariant (ADR-0034 Consequences): a file no project collects is dead weight
    // that will rot unnoticed; a file two projects collect runs twice, and for the clipboard specs
    // that means writing the user's system clipboard twice.
    expect(new Set(collected).size, 'a spec file is collected by two projects').toBe(
      collected.length,
    )
    expect([...specFilesUnder(E2E_ROOT)].sort()).toEqual([...collected].sort())
  })

  it('gives every project at least one spec, so the checks cannot pass vacuously', () => {
    for (const name of PROJECT_NAMES) {
      expect(filesByProject[name].length, `${name} collected no specs`).toBeGreaterThan(0)
    }
  })

  it('never lets a stray *.test.ts / *.spec.ts into a project directory', () => {
    for (const name of PROJECT_NAMES) {
      expect(strayTestFilesUnder(ROOT, dirs[name]), `${name} contains a stray test file`).toEqual(
        [],
      )
    }
  })

  it('never loses a clipboard spec', () => {
    // A LOWER BOUND, not a head-count: the inventory invariant above cannot catch a deleted spec
    // (both sides of that equality shrink together and it stays green), so this is what notices.
    // Adding a seventh spec stays green — update README.md / docs/agents/testing.md, not this guard.
    expect(
      filesByProject['e2e-clipboard'].length,
      'a clipboard spec was deleted or moved out of e2e/clipboard/ — the destructive suite lost coverage',
    ).toBeGreaterThanOrEqual(6)
  })

  it('never loses a clipboard CASE, not just a clipboard file', () => {
    // The file check above only notices a whole spec disappearing. §3.5 requires twenty-one
    // clipboard cases, and deleting one `test(...)` from a spec that stays in place would leave the
    // destructive suite quietly thinner while every file-level assertion stayed green.
    const cases = filesByProject['e2e-clipboard'].reduce(
      (total, file) =>
        total + (readFileSync(file, 'utf-8').match(/^\s*test\(\s*['"`]/gm) ?? []).length,
      0,
    )
    expect(cases, 'the destructive clipboard suite lost a case').toBeGreaterThanOrEqual(21)
  })

  it('keeps every spec importing helpers one level up, as ../helpers/...', () => {
    // ADR-0034 "Invariants that must not change": all specs use this form, and the new directories
    // stay exactly one level below e2e/. A deeper relative path or an alias would silently change
    // which copy of a helper a project resolves.
    const specs = specFilesUnder(E2E_ROOT)
    expect(specs.length, 'the scan must find the specs').toBeGreaterThan(0)
    const offenders = specs.filter((file) => {
      const source = readFileSync(file, 'utf-8')
      return [...source.matchAll(/from\s+['"]([^'"]*helpers\/[^'"]*)['"]/g)]
        .map((match) => match[1])
        .some((specifier) => !/^\.\.\/helpers\//.test(specifier))
    })
    expect(offenders, 'ADR-0034: helper imports must stay ../helpers/...').toEqual([])
  })

  it('registers the large-document perf spec in the gate project only', () => {
    expect(collected.filter((f) => f.endsWith('large-doc-perf.e2e.spec.ts')).length).toBe(1)
    expect(has('e2e-perf-gate', 'large-doc-perf.e2e.spec.ts')).toBe(true)
    expect(has('e2e-perf-diag', 'large-doc-perf.e2e.spec.ts')).toBe(false)
  })

  it('keeps perf-diag threshold-free: diagnostics produce numbers, not verdicts', () => {
    // Check the SEMANTIC property instead of a file-name allowlist, so adding another diagnostic
    // does not require editing this guard. Deliberately narrow: switch-perf contains plain numeric
    // constants (500/20/2, `> 50`), so a broad "any number" check would false-red.
    const specs = filesByProject['e2e-perf-diag']
    expect(specs.length, 'the diagnostic project must collect at least one spec').toBeGreaterThan(0)
    const offenders = specs.filter((file) =>
      /expect\s*\(|toBeLessThan\s*\(|toBeGreaterThan\s*\(/.test(readFileSync(file, 'utf-8')),
    )
    expect(offenders, 'e2e-perf-diag must not assert thresholds').toEqual([])
  })
})
