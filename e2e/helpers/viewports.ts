// The e2e environments, named.
//
// Determinism comes from ONE fixed environment, not from asserting every condition combination:
// a spec that reads "the format cluster is seven buttons" must be able to trust that the same
// buttons exist on a 13" laptop and on the CI runner. `standard` is that environment — every spec
// gets it for free, because helpers/launch.ts pins it before the app is driven.
//
// The pinned size is the app's CONTENT AREA (the web layout viewport that page.setViewportSize
// controls), not the Electron window's outer frame. The app's responsive layout is a function of
// content width — it measures its own DOM via a ResizeObserver and the --sidebar-width variable — and
// the OS frame (title bar + borders, scaled by platform DPI) varies machine to machine. Pinning the
// content area is therefore both necessary and sufficient for determinism; pinning the OS window would
// be neither, so a future reader must not "fix" this by resizing the window instead (see ADR-0026).
//
// A spec that is ABOUT a particular width may enter it, the same way the responsive fixtures do.
// What matters is that entering an environment is a named, shared, documented decision rather
// than a magic number typed into a spec.
//
// The numbers are not free choices; they follow from layout constants:
//   - the window floor is 800            (electron/main/window.ts `minWidth`)
//   - the sidebar default is 288          (Sidebar.tsx `useState(288)`)
//   - the editor pane bar shows all 12 commands inline from 472px up (`ALL_INLINE_AT` in
//     ui/priority-overflow.ts); below that they move into "…" one at a time
// so in split mode the pane is (width - 288) / 2, and a fully expanded bar needs width >= 1232.
//
// e2e/guards/viewports.test.ts checks these invariants against the sources of truth, so a layout
// change that invalidates an environment fails a unit test instead of an e2e run.

/**
 * Column width at which all 12 editor commands fit inline. Mirrors the production budget
 * `ALL_INLINE_AT` in `ui/priority-overflow.ts`; the viewport guard asserts they never drift, so
 * specs can use this instead of typing a magic number.
 */
export const ALL_INLINE_AT = 472

export const VIEWPORTS = {
  /** The default environment: the whole suite runs in it unless a spec opts out. */
  standard: { width: 1024, height: 768 },
  /**
   * Wide enough for the split editor pane to keep every command inline:
   * (1280 - 288) / 2 = 496 >= ALL_INLINE_AT (472).
   */
  wide: { width: 1280, height: 900 },
  /** The narrow fixture size (at the window floor of 800), used by the responsive specs. */
  narrow: { width: 800, height: 600 },
  /**
   * The environment the committed E9 visual baselines were captured in: the global bar is 2272px
   * wide and a pane bar 1136px, i.e. a 2560px content area (2272 = 2560 - 288, and one column is
   * half of that). The visual spec enters it, so the baselines stay valid AND stop depending on the
   * width of the machine that happened to capture them.
   */
  baseline: { width: 2560, height: 1440 },
} as const
