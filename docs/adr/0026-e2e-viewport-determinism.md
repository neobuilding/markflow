# ADR-0026: e2e viewport determinism — pinned named content-area environments

- **Status:** Accepted

## Context

Width-coupled e2e specs — toolbar hit areas (E8), the sidebar query-field floor (C9), the split
pane bars, and the E9 visual baselines — were reproducible on one machine and not another. The app
launches **maximized to the host's work area** (`electron/main/window.ts`), so the size of the
content area it renders into tracked the developer's large monitor on the laptop and the CI runner's
smaller virtual display. An assertion that passed locally silently failed in CI (and vice versa),
with no code change between the two.

## Decision

Pin a **single named environment** for the whole suite and let specs opt into others by name:

- `e2e/helpers/launch.ts` calls `page.setViewportSize(VIEWPORTS.standard)` for every spec, before the
  spec drives the app. `launchApp()` is the only entry point (51 call sites), so this one call covers
  the entire e2e surface.
- The named environments live in `e2e/helpers/viewports.ts` as `VIEWPORTS` (`standard` 1024×768,
  `wide` 1280×900, `narrow` 800×600, `baseline` 2560×1440). Their numbers are derived from layout
  constants (window floor 800, sidebar default 288, `ALL_INLINE_AT` 472 — which superseded the
  earlier `FOLD_AT = 420`, see ADR-0031 §5) and checked by `e2e/guards/viewports.test.ts`.
- A spec that needs a different width **enters a named environment**
  (`page.setViewportSize(VIEWPORTS.wide)`) instead of typing a literal. The same guard forbids
  hand-typed `setViewportSize(...)` numbers.

**The pinned size is the content area, not the OS window frame.** `page.setViewportSize` sets the web
layout viewport — the area the app's DOM fills. The app's responsive layout is a pure function of
content width: it measures its own elements (the sidebar via the `--sidebar-width` variable, the pane
bars via a `ResizeObserver` on their own border box — ADR-0031 §5's progressive overflow). The OS window's outer frame (title bar +
borders, scaled by platform DPI) varies machine to machine, so pinning _it_ would not be
deterministic either. Pinning the content area is therefore both necessary and sufficient; a future
reader must not "improve" this by resizing the OS window.

## Considered Options

- **Pin the OS window outer size** (e.g. `win.setSize` / `--window-size`): rejected — the frame is
  platform/theme/DPI-dependent, so the resulting content area still drifts; and the app never reads
  the OS window size, only its own DOM, so it would not even address the cause.
- **Assert every width combination in each spec**: rejected — that is the e2e anti-pattern of
  enumerating layout matrices in the most expensive test layer; the invariant belongs in CSS + unit
  tests, and e2e only needs a fixed environment.
- **Pin the content area to one named `standard` environment + named alternates**: chosen — fixes the
  cause (content width is fixed), stays reproducible everywhere, and keeps width decisions shared and
  reviewable.

## Consequences

- **Positive:** width-coupled specs behave identically on every machine; the "passes locally, fails in
  CI" class is eliminated at the environment layer, not in the assertions.
- **Positive:** `narrow` (800 content area) deliberately drives each split column to (800 − 288) / 2 =
  256px, well below `ALL_INLINE_AT`, exercising the progressive overflow; `baseline` (2560 content area) matches the
  committed E9 PNGs (global bar 2272 = 2560 − 288, pane bar 1136 = half of that), so the visual spec
  no longer depends on the capturing machine's monitor width.
- **Constraint:** a reasonable reader may be tempted to "also" pin the OS window — do not; the
  content-area pin is the only correct lever. `toolbar-density` is the one spec that still sizes the
  window on purpose (to push the column below the fold); it now does so via the named `narrow`
  environment, not a raw `win.setSize`.
- **Guard rail:** `e2e/guards/viewports.test.ts` fails a unit test (not an opaque e2e timeout) if
  `launch.ts` stops pinning, if a spec types a raw size, or if the committed E9 baselines drift from
  the `baseline` geometry.
