// Guard test: the named e2e environments must keep meaning what they claim.
//
// The e2e suite runs in ONE fixed environment (helpers/launch.ts pins it) so that the same
// assertion behaves the same on a laptop and on the CI runner. That only works if the sizes are
// checked against the layout constants they were derived from: if the sidebar grows or the
// toolbar's fold threshold moves, an environment can silently stop exercising the layout it was
// named for — and the failure then shows up as a confusing e2e timeout, far from the cause.
//
// So this test parses the constants out of the sources of truth and asserts the contract:
//   - every environment is at least the window floor (electron/main/window.ts `minWidth`)
//   - `standard` really does overflow the editor toolbar (pane < ALL_INLINE_AT)
//   - `wide` really does expand it                       (pane >= ALL_INLINE_AT)
//   - `narrow` overflows the editor toolbar even more     (pane < ALL_INLINE_AT)
//   - `baseline` matches the committed E9 visual baselines (their bar widths)
//
// It also guards the convention itself, because convention is not self-enforcing: that
// helpers/launch.ts still pins the standard environment for every spec, that no spec types a
// viewport size of its own, and that the committed baselines and the named environment agree.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { VIEWPORTS } from '../helpers/viewports'
import config from '../../playwright.config'
import { ROOT } from './repo'
import { specFilesUnder } from './scan-specs'
// ADR-0034: specs live in one directory per project. The named-environment rule must cover ALL
// of them — clipboard and perf specs also call setViewportSize — not just e2e/app.
const SPEC_DIRS = (config.projects ?? [])
  .map((project) => project.testDir)
  .filter((dir): dir is string => typeof dir === 'string')

function source(path: string): string {
  return readFileSync(join(ROOT, path), 'utf-8')
}

/** The pixel width of a PNG (the IHDR `width` field: a big-endian uint32 at byte 16). */
function pngWidth(relPath: string): number {
  return readFileSync(join(ROOT, relPath)).readUInt32BE(16)
}

/** The layout constants the environments are derived from, read from the code that owns them. */
const PRIORITY_OVERFLOW = source('src/renderer/src/components/ui/priority-overflow.ts')
// One reader for every "export const NAME = 123" the guard needs: the value is parsed out of the
// SOURCE (importing the module would pull React into this node-side guard), and a missed read
// surfaces as NaN in the vacuity test below, not as a silently green comparison.
function parseConst(name: string, src: string): number {
  return Number(new RegExp(`export const ${name} = (\\d+)`).exec(src)?.[1])
}

// The width at which ALL editor-pane-bar commands fit inline. Below it the bar progressively moves
// the lowest-priority commands into its "…" overflow (ui/priority-overflow.ts).
//
// It is RECOMPUTED here from the budget the production code uses, not read as a literal: the
// threshold has to move WITH the budget, and a guard that compared two hand-written numbers
// could not see the two disagreeing about where "all inline" begins.
const ITEM_SLOT = parseConst('ITEM_SLOT', PRIORITY_OVERFLOW)
const BAR_PADDING = parseConst('BAR_PADDING', PRIORITY_OVERFLOW)
const EDITOR_SEPARATORS = parseConst('EDITOR_SEPARATORS', PRIORITY_OVERFLOW)
const EDITOR_COMMAND_COUNT = parseConst('EDITOR_COMMAND_COUNT', PRIORITY_OVERFLOW)
const ALL_INLINE_AT = ITEM_SLOT * EDITOR_COMMAND_COUNT + BAR_PADDING + EDITOR_SEPARATORS
const HELPER_ALL_INLINE_AT = parseConst('ALL_INLINE_AT', source('e2e/helpers/viewports.ts'))
const SIDEBAR_DEFAULT = Number(
  /setSidebarWidth\] = useState\((\d+)\)/.exec(
    source('src/renderer/src/components/sidebar/Sidebar.tsx'),
  )?.[1],
)
const WINDOW_FLOOR = Number(/minWidth: (\d+)/.exec(source('electron/main/window.ts'))?.[1])

/** The editor pane width in split mode: the content area minus the sidebar, halved. */
const splitPaneWidth = (viewport: { width: number }): number =>
  (viewport.width - SIDEBAR_DEFAULT) / 2

describe('the named e2e environments', () => {
  it('could not read the layout constants — the guard would be vacuous', () => {
    expect(Number.isFinite(ITEM_SLOT)).toBe(true)
    expect(Number.isFinite(BAR_PADDING)).toBe(true)
    expect(Number.isFinite(EDITOR_SEPARATORS)).toBe(true)
    expect(Number.isFinite(EDITOR_COMMAND_COUNT)).toBe(true)
    expect(Number.isFinite(ALL_INLINE_AT)).toBe(true)
    expect(Number.isFinite(SIDEBAR_DEFAULT)).toBe(true)
    expect(Number.isFinite(WINDOW_FLOOR)).toBe(true)
  })

  it('derives the all-inline threshold from the EDITOR bar chrome', () => {
    // Two ways to break this without any test noticing: hand-write the number, or derive it from
    // the WRONG budget (`BAR_PADDING` is the preview bar's 24px, giving 456 instead of 472). Both
    // leave the named environments pinned to a width the editor bar no longer uses, so the
    // assertion names the exact call instead of settling for "some derivation".
    expect(PRIORITY_OVERFLOW).toMatch(
      /export const ALL_INLINE_AT = allInlineWidth\(\s*EDITOR_COMMAND_COUNT,\s*EDITOR_BAR_CHROME\s*\)/,
    )
    // Specs import ALL_INLINE_AT from helpers/viewports.ts; a source change that moved the real
    // threshold must not silently leave those premise checks behind.
    expect(Number.isFinite(HELPER_ALL_INLINE_AT)).toBe(true)
    expect(HELPER_ALL_INLINE_AT).toBe(ALL_INLINE_AT)
  })

  it('keeps every environment at or above the window floor', () => {
    expect(
      Object.keys(VIEWPORTS).length,
      'the named-environment table must not be empty',
    ).toBeGreaterThan(0)
    for (const [name, viewport] of Object.entries(VIEWPORTS)) {
      expect(viewport.width, `${name} is narrower than the app can be`).toBeGreaterThanOrEqual(
        WINDOW_FLOOR,
      )
    }
  })

  it('has `standard` overflow the editor toolbar, so the default environment is unambiguous', () => {
    expect(splitPaneWidth(VIEWPORTS.standard)).toBeLessThan(ALL_INLINE_AT)
  })

  it('has `wide` expand the editor toolbar, so the wide environment is unambiguous', () => {
    expect(splitPaneWidth(VIEWPORTS.wide)).toBeGreaterThanOrEqual(ALL_INLINE_AT)
  })

  it('has `narrow` overflow more commands than `standard`', () => {
    // The app measures the bar's border box, which equals this column width (see
    // ui/priority-overflow.ts reading `borderBoxSize`), so comparing the column width to
    // ALL_INLINE_AT is exactly the quantity the real layout compares against — not the content
    // box, which would subtract the bar's padding. The overflow is progressive: `narrow` is a
    // smaller column than `standard`, so MORE commands are in "…", not a separate mode.
    expect(splitPaneWidth(VIEWPORTS.narrow)).toBeLessThan(ALL_INLINE_AT)
    expect(splitPaneWidth(VIEWPORTS.narrow)).toBeLessThan(splitPaneWidth(VIEWPORTS.standard))
  })

  it('pins the standard environment for every spec in the shared launch helper', () => {
    // The whole determinism argument rests on THIS call: launchApp() resizes the window before the
    // spec drives the app, so the layout never tracks the host's monitor size. If the call is
    // deleted, every width-coupled assertion silently becomes host-dependent again — and no other
    // test in the suite would fail. So the pin itself is guarded.
    const launch = source('e2e/helpers/launch.ts')
    expect(launch, 'launch.ts must pin a viewport for every spec').toMatch(/setViewportSize\(/)
    expect(launch, 'launch.ts must pin the STANDARD environment').toMatch(/VIEWPORTS\.standard/)
  })

  it('lets specs enter only named environments, never a hand-typed size', () => {
    // A spec that types its own numbers re-creates exactly the drift the named environments exist
    // to remove — and the number would be invisible to the contract asserted above. Entering an
    // environment must stay a shared, documented decision.
    const offenders: string[] = []
    let seen = 0
    expect(SPEC_DIRS.length, 'the scan must cover every project directory').toBeGreaterThan(0)
    for (const dir of SPEC_DIRS) {
      // Recursive: a spec nested in a subdirectory is still a spec this project runs, and a
      // one-level scan would let it pick a viewport size of its own unnoticed.
      for (const file of specFilesUnder(dir)) {
        const src = readFileSync(file, 'utf-8')
        for (const match of src.matchAll(/setViewportSize\(\s*([^)]*)\)/g)) {
          seen++
          if (!/^VIEWPORTS\.\w+$/.test(match[1].trim())) {
            offenders.push(`${relative(ROOT, file)}: ${match[0].trim()}`)
          }
        }
      }
    }
    // Non-vacuous: the scan must actually see the calls it polices (chrome-visual pins the
    // baseline environment). If the pattern ever stopped matching, an empty offender list
    // would mean nothing, not compliance.
    expect(seen).toBeGreaterThan(0)
    expect(offenders, 'specs must enter a named environment instead of a literal size').toEqual([])
  })

  it('keeps the committed E9 visual baselines in step with the baseline environment', () => {
    // The visual baselines are pixel-exact, so the environment they were captured in has to be
    // named and reproducible — otherwise the spec silently depends on the width of the monitor that
    // captured them. The arithmetic is the same one the bars use at that width: the global bar
    // spans the content area, a pane bar is one column of it (the split divider takes the odd
    // pixel, hence the tolerance on the preview bar).
    const dir = 'e2e/app/chrome-visual.e2e.spec.ts-snapshots'
    const content = VIEWPORTS.baseline.width - SIDEBAR_DEFAULT
    // The baseline images show the FULLY EXPANDED bar, so the column must stay above
    // ALL_INLINE_AT: if that width moves past this column, the committed PNGs go stale and the
    // spec should say so here rather than as an opaque screenshot diff.
    expect(splitPaneWidth(VIEWPORTS.baseline)).toBeGreaterThanOrEqual(ALL_INLINE_AT)
    expect(
      pngWidth(`${dir}/global-bar-e2e-app-win32.png`),
      'the global bar spans the whole content area',
    ).toBe(content)
    expect(
      pngWidth(`${dir}/editor-pane-bar-e2e-app-win32.png`),
      'the editor pane bar is one column of the content area',
    ).toBe(content / 2)
    expect(
      pngWidth(`${dir}/editor-pane-bar-dark-e2e-app-win32.png`),
      'the dark baseline is that same column',
    ).toBe(content / 2)
    expect(
      Math.abs(pngWidth(`${dir}/preview-pane-bar-e2e-app-win32.png`) - content / 2),
      'the preview pane bar is the other column',
    ).toBeLessThanOrEqual(1)
  })
})
