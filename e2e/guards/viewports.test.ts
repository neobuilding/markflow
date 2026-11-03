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
//   - `standard` really does fold the editor toolbar  (pane < FOLD_AT)
//   - `wide` really does expand it                     (pane >= FOLD_AT)
//   - `narrow` folds the editor toolbar                  (pane < FOLD_AT)
//   - `baseline` matches the committed E9 visual baselines (their bar widths)
//
// It also guards the convention itself, because convention is not self-enforcing: that
// helpers/launch.ts still pins the standard environment for every spec, that no spec types a
// viewport size of its own, and that the committed baselines and the named environment agree.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VIEWPORTS } from '../helpers/viewports'

// The repo root, derived from THIS file's location rather than from process.cwd(): the guard must
// read the same sources no matter which directory the test run was started from. The repo's other
// e2e helpers resolve their paths the same way (see helpers/launch.ts).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SPEC_DIR = join(ROOT, 'e2e', 'specs')

function source(path: string): string {
  return readFileSync(join(ROOT, path), 'utf-8')
}

/** The pixel width of a PNG (the IHDR `width` field: a big-endian uint32 at byte 16). */
function pngWidth(relPath: string): number {
  return readFileSync(join(ROOT, relPath)).readUInt32BE(16)
}

/** The layout constants the environments are derived from, read from the code that owns them. */
const FOLD_AT = Number(
  /const FOLD_AT = (\d+)/.exec(source('src/renderer/src/components/editor/EditorPaneBar.tsx'))?.[1],
)
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
    expect(Number.isFinite(FOLD_AT)).toBe(true)
    expect(Number.isFinite(SIDEBAR_DEFAULT)).toBe(true)
    expect(Number.isFinite(WINDOW_FLOOR)).toBe(true)
  })

  it('keeps every environment at or above the window floor', () => {
    for (const [name, viewport] of Object.entries(VIEWPORTS)) {
      expect(viewport.width, `${name} is narrower than the app can be`).toBeGreaterThanOrEqual(
        WINDOW_FLOOR,
      )
    }
  })

  it('has `standard` fold the editor toolbar, so the default environment is unambiguous', () => {
    expect(splitPaneWidth(VIEWPORTS.standard)).toBeLessThan(FOLD_AT)
  })

  it('has `wide` expand the editor toolbar, so the wide environment is unambiguous', () => {
    expect(splitPaneWidth(VIEWPORTS.wide)).toBeGreaterThanOrEqual(FOLD_AT)
  })

  it('has `narrow` fold the editor toolbar (single fold threshold)', () => {
    // The app measures the bar's border box, which equals this column width (see EditorPaneBar.tsx
    // reading `borderBoxSize`), so comparing the column width to FOLD_AT is exactly the quantity the
    // real layout compares against — not the content box, which would subtract the bar's padding.
    // Q3 collapsed the old wide/folded/minimal model into a single threshold, so `narrow` is now a
    // folded column (pane < FOLD_AT), not a separate minimal mode.
    expect(splitPaneWidth(VIEWPORTS.narrow)).toBeLessThan(FOLD_AT)
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
    for (const file of readdirSync(SPEC_DIR).filter((f) => f.endsWith('.e2e.spec.ts'))) {
      const src = readFileSync(join(SPEC_DIR, file), 'utf-8')
      for (const match of src.matchAll(/setViewportSize\(\s*([^)]*)\)/g)) {
        seen++
        if (!/^VIEWPORTS\.\w+$/.test(match[1].trim())) {
          offenders.push(`${file}: ${match[0].trim()}`)
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
    const dir = 'e2e/specs/chrome-visual.e2e.spec.ts-snapshots'
    const content = VIEWPORTS.baseline.width - SIDEBAR_DEFAULT
    // The baseline images show the EXPANDED format cluster, so the column must stay above FOLD_AT:
    // if that threshold moves past this column width, the committed PNGs go stale and the spec
    // should say so here rather than as an opaque screenshot diff.
    expect(splitPaneWidth(VIEWPORTS.baseline)).toBeGreaterThanOrEqual(FOLD_AT)
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
