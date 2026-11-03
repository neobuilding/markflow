# Testing conventions

Conventions that keep the unit suite deterministic across machines. CI runs on Linux while most
development happens on Windows, so a test that quietly depends on its host is a test that passes
locally and fails in CI.

## Test data must not inherit the host platform's path shape

`node:path` is platform-polymorphic: on Windows `path.join()` yields backslashes and `path.sep`
is `\`; on POSIX both are forward slashes. Fixtures built with the host `join()` are therefore
_different data_ on different machines, and any branch keyed on separator shape ends up covered
on one platform only.

This already cost a CI failure: the `d.filePath.includes('\\') ? '\\' : '/'` ternary in
`rePointFileRecord` (`electron/main/ipc/documents.ts`) reached 100% locally and only 99.47% in
CI, because on Linux no stored record ever contained a backslash.

Rules:

- When a test needs a specific separator shape, construct it explicitly — `path.win32.join(...)`
  or `path.posix.join(...)` (both are pure JS and behave identically on every host), or a literal
  such as `'C:\\docs\\x.md'`. Never rely on the host `join()` to produce it.
- Cover both shapes when the code branches on separator style.
- Do not mock `node:path` to fake a platform. That makes the coverage number green without
  proving the logic is correct on the platform actually running the tests.

## Filesystem access goes through the DiskIO port

`electron/main/lib/disk-io.ts` holds the port, a real `node:fs` adapter (`nodeDiskIO`) and an
in-memory implementation (`createMemoryDiskIO`). IPC handlers take it as a parameter with a
default, so production callers stay unchanged while tests inject a fake.

- `nodeDiskIO` is a humble adapter: one-line forwards, no logic. It is verified once against a
  real temp directory in `disk-io.test.ts`; nothing above it needs a real disk.
- Prefer `createMemoryDiskIO()` in unit tests. Paths become opaque keys, so a test can use any
  path shape — including ones no real filesystem would accept.
- Assert resulting state, not "which method was called how many times". The in-memory
  implementation is a fake, not a mock.

## Every temp directory is allocated through a registry that reclaims it

A suite that needs a real directory must allocate it through the registry helper of its layer,
never with a bare `mkdtempSync(join(tmpdir(), prefix))`:

| Layer      | Helper                                              | Reclaimed by                                    |
| ---------- | --------------------------------------------------- | ----------------------------------------------- |
| Unit tests | `mkTestDir()` — `electron/main/test-support/tmp.ts` | `afterAll` hook in `test-setup.ts`              |
| e2e specs  | `mkTempDir()` — `e2e/helpers/temp.ts`               | `cleanupTempDirs()` in `closeApp()`'s `finally` |

Each helper records only the paths IT created and removes exactly those — no `%TEMP%` scan, so
it can never delete a directory another process owns. That ownership rule is the point: whoever
allocates a directory reclaims it (`test-support/tmp.test.ts` pins this contract).

Why this is not optional: nothing in the toolchain cleans `%TEMP%`. A single `npm run verify` once
left dozens of `mf-*` / `fw-*` / `of-*` directories behind and **every test still passed** — the
suite was green while the machine slowly filled up. A `try/finally` + `rmSync` also "works", but
it is skipped when a test fails mid-way, so prefer the helper. Production code follows the same
rule (`mf-print-*` in `export.ts` removes its temp dir in `finally`).

## The OS clipboard is its own Playwright project

Playwright cannot intercept the real clipboard, and mocking it would defeat the point of the specs
that use it (a real copy event producing a real payload). That makes those tests destructive by
nature: they overwrite whatever the user has copied and write it back afterwards, and a run
interrupted mid-test leaves the test payload behind.

So they run only where that cost buys something. The six specs that touch the clipboard
(`select-all-copy-fidelity`, `pane-toolbars`, `preload-contract`, `formula-copy-image`,
`copy-once-no-drop-diagrams`, `context-menu`) are matched by the **`e2e-clipboard`** project in
`playwright.config.ts` — the only project that sets the `clipboardE2e` option
(`e2e/helpers/fixtures.ts`). Every other project leaves it false:

```bash
npm run e2e:app        # those specs are reported as skipped, with a reason
npm run e2e:clipboard  # the project runs them for real; CI does too via `e2e:full`
```

A spec reads the option from `helpers/fixtures.ts` and gates itself before it touches the
clipboard:

```ts
test.beforeEach(async ({ clipboardE2e }) => {
  test.skip(!clipboardE2e, CLIPBOARD_SPEC_SKIP_REASON)
  // … launch, snapshot, run
})
```

It captures its snapshot only when the option is set — `restoreClipboard` treats `undefined` as
"nothing to do", so a run in any other project performs no clipboard write at all (not even putting
back what was already there).

Why an option and not an environment variable: what a run is allowed to do stays visible in the
config, next to the project that allows it, instead of hiding in a variable a developer has to know
about. And a test switch must never reach the app either (ADR 0016,
`electron/main/test-support/no-test-env-switches.test.ts`).

Two unit tests guard the arrangement (they live in `e2e/`, and `vitest.config.ts` picks up
`e2e/**/*.test.ts` — a pattern that cannot match a `*.e2e.spec.ts` spec):

- `e2e/guards/clipboard-project.test.ts` — the project claims exactly the specs that touch the
  clipboard, each of them imports the extended `test` and gates itself on the option, and no other
  project may set it. It also asserts that the option is _wired_ to the exported
  `CLIPBOARD_E2E_DEFAULT` constant: checking the constant alone would stay green if the fixture
  were hard-wired to `true`. The failure it prevents is silent: a clipboard spec missing from the
  project would write the user's clipboard inside `npm run e2e:app`, and nothing would fail.
- `e2e/helpers/clipboard.test.ts` — the skip reasons a developer reads in a report.

Coverage of the same handler boundary that needs no real clipboard lives in
`electron/main/handlers/app.test.ts` (mocked `clipboard`, `ClipboardItem` from the electron export).

## Browser APIs jsdom does not implement

jsdom implements the DOM, not the browser: a handful of APIs the app uses are simply absent, and a
suite that touches one dies with `X is not a function` / `X is not defined` before it can assert
anything. There are two ways to deal with that, and which one to use follows from what the test
needs:

| Case                                                                 | Approach                                                                                                                                                              |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The API's **value** is irrelevant to the assertion                   | Polyfill it once in `test-setup.ts` (`Range.getClientRects`, `IntersectionObserver`, `ResizeObserver`) so no suite has to think about it                              |
| The API's **value** IS the assertion (e.g. the OS colour preference) | Stub it **in the test**, and restore it afterwards (`window.matchMedia` in `components/preview/MarkdownPreview.test.tsx`, `lib/export.test.ts`, `App.theme.test.tsx`) |

Production code must not care whether the host implements the API: it reads the optional form
(`window.matchMedia?.(…)`) or an explicit existence guard, so a missing API degrades to a defined
behaviour instead of a crash. A test that has to stub an API is also a reminder that the production
path needs the same guard — otherwise the suite passes and the app throws.

## What the gates cover — and what they deliberately don't

`npm run typecheck` runs four programs. Between them, every `.ts`, `.tsx`, `.mjs` and `.cjs` file in
the repo belongs to exactly one:

| Program                 | Owns                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `tsconfig.web.json`     | renderer production code (`src/renderer/src`, no tests)                                                                       |
| `tsconfig.node.json`    | main process + preload                                                                                                        |
| `tsconfig.tests.json`   | unit/e2e tests, `scripts/`, the root tooling configs (`*.config.ts`, `*.config.cjs`, `eslint.config.mjs`), `e2e/integration/` |
| `tsconfig.scripts.json` | the standalone JS islands: `actions/create-pr/**` (its own npm package), `.github/create-pr/blocks/**`, `examples/**`         |

`allowJs` + `checkJs` are ON in `tsconfig.tests.json`, so its `.mjs` files are really type-checked
(they carry JSDoc where inference runs out). They are OFF in `tsconfig.scripts.json`: that code is
plain JS shipped as a bundle, so annotating it would be a rewrite (~270 findings). Measured
behaviour: with `checkJs: false` only PARSE errors are reported (a bad import is not), so that
program is a syntax gate for the scripts that would otherwise have no gate at all — e.g. the
create-pr action's entry point, which no unit test imports. The parts that carry logic have their
own vitest suites.

Two traps that let files escape the gates, both closed — keep them in mind before moving files:

- **An `include` pattern with no program behind it checks nothing.** `tsconfig.tests.json` listed
  `scripts/**/*.mjs` while `allowJs` was off, so those files were parsed by nobody.
- **TypeScript 7 drops a `*.tsx` that has a same-named `*.ts` sibling** during include expansion
  (verified with a two-file repro). That is why `store/ui.test.tsx` is listed in `files` rather than
  reached by the `**/*.tsx` pattern. Avoid creating same-basename `.ts`/`.tsx` pairs.

On the lint side, `eslint .` covers every JS/TS file except `*.d.ts` (ambient or generated
declarations). Config files used to be ignored wholesale via `**/*.config.ts`; they are linted now,
with `tsconfig.tests.json` as their type gate.

The coverage gate has its own version of the same trap: `coverage.include` is a list of globs, and a
`*.ts`-only glob silently drops a future `.tsx` module from the 100%-per-file gate. Every renderer
pattern therefore uses `{ts,tsx}` (`lib/`, `hooks/`, `components/`, `store/`, `i18n/`).

## Width-coupled e2e specs enter a named environment

Determinism comes from ONE fixed environment, not from asserting every condition combination. The
e2e suite runs in a single pinned **content-area** viewport (`VIEWPORTS.standard`, applied by
`e2e/helpers/launch.ts` before the app is driven) — the app measures its own DOM, so pinning the
content area (the web layout viewport, not the OS window frame) is what makes the layout
deterministic. The same assertion therefore behaves the same on a laptop and on the CI runner — the
"passes on my big monitor, fails on the CI runner" class dies here, not in the assertions.

A spec that is _about_ a particular width enters a named environment instead of typing its own
numbers (`e2e/helpers/viewports.ts`):

| Environment | Size        | What it exercises                                                                                  |
| ----------- | ----------- | -------------------------------------------------------------------------------------------------- |
| `standard`  | 1024 × 768  | the default: the editor toolbar is FOLDED (pane 368 < 420)                                         |
| `wide`      | 1280 × 900  | the editor toolbar is EXPANDED (pane 496 >= 420)                                                   |
| `narrow`    | 800 × 600   | the narrow fixture size (at the app's window floor); the editor toolbar is FOLDED (pane 256 < 420) |
| `baseline`  | 2560 × 1440 | the E9 visual baselines (the bars are 2272px / 1136px wide)                                        |

Entering an environment is per CASE, not per file: a spec that needs a different window gets its own
test case for it, while the case that stays in the default environment keeps asserting the default
layout. `e2e/specs/pane-toolbars.e2e.spec.ts` has both — one case asserts the split-mode ownership in
the default (folded) environment, and a second, dedicated case enters `wide` to assert the expanded
format cluster.

The sizes are not free choices: they follow from the window floor (800), the sidebar default (288)
and the toolbar's fold threshold (`FOLD_AT` 420), so in split mode the pane is `(width - 288) / 2`.
`e2e/guards/viewports.test.ts` parses those constants out of the sources of truth and asserts the
contract — that `standard` really folds, `wide` really expands, `narrow` also folds (there is ONE
fold threshold, so a narrow column is a folded column, not a separate mode), and no environment is
narrower than the app can be. A layout change that invalidates an
environment therefore fails a unit test, not an e2e timeout far from the cause. The same guard also
protects the convention itself: that `e2e/helpers/launch.ts` still pins the standard environment for
every spec (deleting that call would silently make the whole suite host-dependent again, with
nothing else failing), that no spec types a viewport size of its own instead of entering a named
environment, and that the committed E9 visual baselines still match the geometry of the `baseline`
environment.

## Glossary

Test-infrastructure terms used above.

- **viewport (e2e)**: the web **content area** the app renders into — what `page.setViewportSize()`
  sets. Distinct from the OS window's outer frame (title bar + borders). All width-coupled layout is
  driven by the content area, never the OS frame. _Avoid_: window size, OS window.
- **named environment**: one of the `VIEWPORTS` entries in `e2e/helpers/viewports.ts`
  (`standard`, `wide`, `narrow`, `baseline`) — a shared, reviewed width decision a spec enters by name
  instead of typing a literal pixel size. _Avoid_: custom size, magic number.
- **content area vs OS window**: the content area is the layout viewport (`setViewportSize` controls
  it); the OS window is the outer frame around it. Pinning the content area is deterministic; pinning
  the OS window is not, because the frame varies by platform, theme, and DPI.

## Terminology

Test doubles, as defined in Meszaros' _xUnit Test Patterns_:

| Double | Meaning                                                                       |
| ------ | ----------------------------------------------------------------------------- |
| Dummy  | Fills a parameter, never used                                                 |
| Stub   | Returns preset values; calls are not verified                                 |
| Spy    | Records calls **and forwards to the real implementation**                     |
| Mock   | Replaces the real implementation, presets expectations, verifies interactions |
| Fake   | A real working simplified implementation (in-memory store, in-memory disk)    |

The sharpest line between spy and mock: a spy **observes** the real thing, a mock **replaces**
it. In Vitest both share one API (`vi.spyOn()` vs `vi.fn()`), so the practical difference is
only whether a real host exists and whether it still runs.
