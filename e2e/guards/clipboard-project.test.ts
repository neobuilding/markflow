// Contract guard, not a behaviour test: these assertions lock repository conventions (which
// project may write the real clipboard, how specs obtain the app) rather than application logic.
//
// Guard test: the clipboard specs and the Playwright project that runs them must not drift apart.
//
// The failure this prevents is quiet and expensive: a spec that writes the REAL system clipboard
// but is not part of the `e2e-clipboard` project would run inside `npm run e2e:app` — i.e. on a
// developer's desktop, overwriting whatever they had copied. Nothing would fail; the damage
// would simply be done. The reverse drift (the project claims a spec that never touches the
// clipboard) only wastes CI minutes.
//
// These checks are about the CONFIG, not about the clipboard: which specs the project claims,
// that each of them goes through the shared fixture that owns the destructive gate, and that no
// other project may set the option.
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import config from '../../playwright.config'
import { CLIPBOARD_E2E_DEFAULT, CLIPBOARD_OPTION_DECLARATION } from '../helpers/fixtures'
import { ROOT } from './repo'
import { specFilesUnder } from './scan-specs'

const PROJECT_NAME = 'e2e-clipboard'
const projects = config.projects ?? []

/**
 * The clipboard project's OWN spec directory (ADR-0034: one project, one directory).
 * playwright.config.ts derives `testDir` from `import.meta.url`, so it is absolute no matter
 * which directory the run was started from — a `process.cwd()` fallback would only hide a config
 * regression behind a silently different path.
 */
const project = projects.find((p) => p.name === PROJECT_NAME)

function specDir(): string {
  const dir = project?.testDir
  if (!dir || typeof dir !== 'string') {
    throw new Error(PROJECT_NAME + ' must define its own testDir (ADR-0034)')
  }
  return dir
}

/** The clipboardE2e option a project sets, if any. */
function optionOf(p: { use?: unknown }): boolean | undefined {
  return (p.use as { clipboardE2e?: boolean } | undefined)?.clipboardE2e
}

// The spec files of this project, RECURSIVELY: a spec nested in a subdirectory is still a spec
// this project runs, so a one-level scan would let it slip past every check below.
const specFiles = specFilesUnder(specDir()).map((file) => relative(specDir(), file))
const sourceOf = (file: string): string => readFileSync(join(specDir(), file), 'utf-8')
// Depth-tolerant: also matches '../../helpers/…' or any other relative depth, and a subpath
// import such as '../helpers/clipboard/index'.
const importsHelper = (file: string, helper: string): boolean =>
  new RegExp(`from ['"][./]+helpers/${helper}(/[^'"]*)?['"]`).test(sourceOf(file))
/**
 * A spec reaches the REAL system clipboard only through the shared clipboard fixture: it takes the
 * app from that fixture, and the fixture is what launches, snapshots, restores and closes it. A
 * spec that launched its own app would bypass both the destructive gate and the restore — so
 * "uses the fixture" is the marker, and it is what the cross-directory scan looks for too.
 */
const reachesClipboard = (source: string): boolean =>
  /\bclipboardApp\b/.test(source) ||
  new RegExp(`from ['"][./]+helpers/clipboard(/[^'"]*)?['"]`).test(source)
const clipboardSpecs = specFiles.filter((file) => reachesClipboard(sourceOf(file)))

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

  it('wires the safe default into the fixture option that specs actually read', () => {
    // The claim "every other project leaves the clipboard alone" lives in the fixture DECLARATION,
    // not in the constant: wiring `[true, { option: true }]` would leave the constant — and the
    // assertion above — green while every project started writing the user's clipboard. The old
    // source-text regex was removed; the declaration is now exported data, so this checks the real
    // value without parsing a file.
    expect(
      CLIPBOARD_OPTION_DECLARATION[0],
      'the clipboardE2e option must default to CLIPBOARD_E2E_DEFAULT',
    ).toBe(CLIPBOARD_E2E_DEFAULT)
    expect(
      CLIPBOARD_OPTION_DECLARATION[1].option,
      'the declaration must stay settable from a project use block',
    ).toBe(true)
  })

  it('detects at least one clipboard spec, so the checks below cannot pass vacuously', () => {
    // If the import regex ever stops matching (helper renamed, specifier rewritten),
    // clipboardSpecs collapses to [] and 'covers exactly' would pass against nothing.
    expect(
      clipboardSpecs.length,
      'the clipboard-spec marker must still find specs — fix the marker, not this expectation',
    ).toBeGreaterThan(0)
  })

  it('covers exactly the specs that touch the clipboard', () => {
    // With one directory per project (ADR-0034) the directory IS the boundary — there is no
    // testMatch left to drift. Every spec in this project's testDir must touch the real clipboard,
    // and every clipboard spec must live in that directory.
    expect([...specFiles].sort()).toEqual([...clipboardSpecs].sort())
  })

  it('makes every clipboard spec import the extended test, so the option exists in it', () => {
    const offenders = clipboardSpecs.filter((file) => !importsHelper(file, 'fixtures')).sort()
    expect(offenders).toEqual([])
  })

  it('makes every clipboard spec use the shared fixture that owns the destructive gate', () => {
    // The gate used to be repeated in six specs — and had already drifted apart (three skipped
    // before launching the app, three launched first and snapshotted conditionally). It now lives
    // in the fixture that launches the app, so a spec cannot forget it. What each spec must still
    // do is take the app from that fixture: a spec that launched its own would write the
    // clipboard without the gate and without the restore.
    const offenders = clipboardSpecs
      .filter((file) => !/\bclipboardApp\b/.test(sourceOf(file)))
      .sort()
    expect(offenders, 'a clipboard spec launched its own app and bypassed the shared gate').toEqual(
      [],
    )
    // The gate itself (`test.skip(!clipboardE2e, …)` inside the fixture) is NOT pinned by a
    // source-text match anymore: a regex could only prove a string was present. Its behaviour was
    // verified directly on 2026-11-07 — setting `clipboardE2e: false` produced `1 skipped` (not
    // failed) and stopped before launching Electron, so no clipboard was touched.
  })

  it('keeps every clipboard spec inside the clipboard project directory', () => {
    // Scanning only specDir() cannot catch the dangerous drift: a clipboard spec moved into
    // another project's testDir would run in `npm run e2e:app` and overwrite the user's clipboard
    // while every assertion above stayed green. The scan is recursive, so a spec hidden in a
    // subdirectory does not escape either.
    const otherDirs = projects
      .filter((p) => p.name !== PROJECT_NAME && typeof p.testDir === 'string')
      .map((p) => p.testDir as string)
    expect(
      otherDirs.length,
      'the cross-project scan must actually visit the other project directories',
    ).toBeGreaterThan(0)
    const scanned = otherDirs.flatMap((dir) => specFilesUnder(dir))
    expect(
      scanned.length,
      'the cross-project scan must actually read spec files, not empty directories',
    ).toBeGreaterThan(0)
    const offenders: string[] = []
    for (const file of scanned) {
      const src = readFileSync(file, 'utf-8')
      if (reachesClipboard(src)) {
        offenders.push(file)
      }
    }
    expect(
      offenders,
      'a clipboard spec outside e2e/clipboard/ would overwrite the user clipboard in e2e:app',
    ).toEqual([])
  })

  it('keeps the ownership guard in place, so the wider contract cannot be deleted unnoticed', () => {
    // This file can only assert that the clipboard specs are where they belong; the WIDER contract
    // (one spec file, one project, every spec collected exactly once) lives in a second guard. If
    // that guard were deleted, nothing here would notice — so its existence is asserted from a
    // file that is still there.
    expect(existsSync(join(ROOT, 'e2e', 'guards', 'project-ownership.test.ts'))).toBe(true)
  })
})
