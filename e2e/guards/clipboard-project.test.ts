// Guard test: the clipboard specs and the Playwright project that runs them must not drift apart.
//
// The failure this prevents is quiet and expensive: a spec that writes the REAL system clipboard
// but is not part of the `e2e-clipboard` project would run inside `npm run e2e:app` — i.e. on a
// developer's desktop, overwriting whatever they had copied. Nothing would fail; the damage
// would simply be done. The reverse drift (the project claims a spec that never touches the
// clipboard) only wastes CI minutes.
//
// These checks are about the CONFIG, not about the clipboard: which specs the project claims,
// that each of them gates itself, and that no other project may set the option.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import config from '../../playwright.config'
import { CLIPBOARD_E2E_DEFAULT } from '../helpers/fixtures'

const PROJECT_NAME = 'e2e-clipboard'
const projects = config.projects ?? []
// The repo root, derived from THIS file's location (the same convention as
// e2e/helpers/launch.ts and e2e/guards/viewports.test.ts), for reading sources outside testDir.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const repoSource = (relPath: string): string => readFileSync(join(ROOT, relPath), 'utf-8')

/**
 * The spec directory, taken straight from the config. playwright.config.ts derives `testDir` from
 * `import.meta.url`, so it is absolute no matter which directory the run was started from — a
 * `process.cwd()` fallback would only hide a config regression behind a silently different path.
 */
function specDir(): string {
  if (!config.testDir) throw new Error('playwright.config.ts must define testDir')
  return config.testDir
}
const project = projects.find((p) => p.name === PROJECT_NAME)

/** The clipboardE2e option a project sets, if any. */
function optionOf(p: { use?: unknown }): boolean | undefined {
  return (p.use as { clipboardE2e?: boolean } | undefined)?.clipboardE2e
}

/** Playwright matches testMatch against the spec path relative to testDir. */
function isMatchedByProject(specFile: string): boolean {
  const raw = project?.testMatch ?? []
  const list = Array.isArray(raw) ? raw : [raw]
  return list
    .filter((m): m is RegExp => m instanceof RegExp)
    .some((m) => new RegExp(m.source, m.flags.replace('g', '')).test(specFile))
}

const specFiles = readdirSync(specDir()).filter((f) => f.endsWith('.e2e.spec.ts'))
const sourceOf = (file: string): string => readFileSync(join(specDir(), file), 'utf-8')
// Depth-tolerant: also matches '../../helpers/…' or any other relative depth.
const importsHelper = (file: string, helper: string): boolean =>
  new RegExp(`from ['"][./]+helpers/${helper}['"]`).test(sourceOf(file))
const clipboardSpecs = specFiles.filter((file) => importsHelper(file, 'clipboard'))

describe('the ' + PROJECT_NAME + ' Playwright project', () => {
  it('exists', () => {
    expect(
      project,
      'playwright.config.ts must define the ' + PROJECT_NAME + ' project',
    ).toBeDefined()
  })

  it('is the only project that may touch the OS clipboard', () => {
    const opted = projects.filter((p) => optionOf(p) === true).map((p) => p.name)
    expect(opted).toEqual([PROJECT_NAME])
  })

  it('turns the option on for its own specs', () => {
    expect(optionOf(project ?? {})).toBe(true)
  })

  it('keeps the option off by default, so any other project leaves the clipboard alone', () => {
    expect(CLIPBOARD_E2E_DEFAULT).toBe(false)
  })

  it('wires that default into the fixture, so the constant is what the specs actually get', () => {
    // The claim "every other project leaves the clipboard alone" lives in the fixture declaration,
    // not in the constant: wiring `[true, { option: true }]` would leave the constant — and the
    // assertion above — green while every project started writing the user's clipboard.
    expect(
      repoSource('e2e/helpers/fixtures.ts'),
      'the clipboardE2e option must default to CLIPBOARD_E2E_DEFAULT',
    ).toMatch(/clipboardE2e:\s*\[\s*CLIPBOARD_E2E_DEFAULT\s*,\s*\{\s*option:\s*true\s*\}\s*\]/)
  })

  it('detects at least one clipboard spec, so the checks below cannot pass vacuously', () => {
    // If the import regex ever stops matching (helper renamed, specifier rewritten),
    // clipboardSpecs collapses to [] and 'covers exactly' would pass against nothing.
    expect(clipboardSpecs.length).toBeGreaterThan(0)
  })

  it('covers exactly the specs that touch the clipboard', () => {
    // A spec that touches the clipboard but is missing here would write the user's clipboard in
    // npm run e2e:app; a spec listed here that does not touch it only wastes CI minutes.
    const matched = specFiles.filter(isMatchedByProject).sort()
    expect(matched).toEqual([...clipboardSpecs].sort())
  })

  it('makes every clipboard spec import the extended test, so the option exists in it', () => {
    const offenders = clipboardSpecs.filter((file) => !importsHelper(file, 'fixtures')).sort()
    expect(offenders).toEqual([])
  })

  it('makes every clipboard spec gate itself on the option', () => {
    // Without the gate the spec would run (and write) in EVERY project, which is exactly what
    // the project split exists to prevent. The canonical gate is `test.skip(!clipboardE2e, …)`.
    const offenders = clipboardSpecs
      .filter((file) => !/test\.skip\(\s*!\s*clipboardE2e\b/.test(sourceOf(file)))
      .sort()
    expect(offenders).toEqual([])
  })
})
