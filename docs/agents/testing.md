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

### A clean run must leave zero residue — the residue gate proves it

The registry above only makes a _leak possible to clean up_; it does not _prove_ cleanup ran. A
regression that made the app's `will-quit` cleanup silently no-op would still pass every test
while leaving directories behind. So the e2e layer adds a **residue gate** (ADR-0036):

- `e2e/helpers/temp.ts` appends every allocated directory to a **run-scoped** registry
  `e2e/.residue-registry/<process.pid>.jsonl` (`recordAllocation(dir)`); `mkTempDir` calls it.
  `untrackTempDir` does **not**, so the gate also verifies the app
  removed directories it was expected to own. `global-setup.ts` calls `resetResidueRegistry()` at
  the start of each run, so a crashed worker's stale list never leaks into the next run. A write
  failure is **loud**, not best-effort: the registry is the gate's only input, and an unrecorded
  allocation is invisible residue. The gate itself never deletes the registry — doing so raced a
  live worker. The three bookkeeping wirings are pinned by `e2e/guards/residue-registry.test.ts`,
  whose ignore-rule check is a pure function with a UT covering both LF and CRLF checkouts.
- Every temp-allocating project (`e2e-app`, `e2e-clipboard`, `e2e-perf-gate`, and the on-demand
  `e2e-perf-diag`) sets
  `teardown: 'residue-gate'`, pinned by `e2e/guards/e2e-parallelism.test.ts`. That guard **derives**
  the set: it scans each project's specs (through the shared `scan-specs.ts`) for imports of helper
  modules that allocate temp dirs — the helper set itself is derived from helper sources, so a spec
  importing only a wrapper such as `fixtures.ts` / `perf-fixture.ts` cannot escape. Playwright's
  `--project` filtering and all four `--shard`s pulling the teardown project in were verified with
  `--list`, not pinned by a Vitest guard (framework behaviour, see "Assert the logic you wrote").
  The single spec reads the registry, captures **evidence** of leftovers, cleans them, and only
  **then** asserts on the captured list. A leftover is a real failed test (JUnit `failed`, not a
  run-level `error`).
- The gate waits ONE shared deadline, derived from the app deleter's worst case
  (`DEFER_DELAY_MS + RETRY_GRACE_MS`, exported from `temp-cleanup.ts`) plus a margin. A shorter
  hardcoded grace turns a slow-but-successful delete into a false red; `temp.test.ts` pins the
  relation.
- The gate checks only paths **this run registered** — it never scans `%TEMP%/markflow-*` by
  prefix, so it can never touch a live instance's profile. It is a verifier, not a sweeper.

**Test pyramid:** the audit logic (`readResidueRegistry` / `findResidue` / `cleanupResidue`), the
registry bookkeeping (`recordAllocation` / `resetResidueRegistry`), the harness ownership path
(`mkTempDir` / `untrackTempDir` / `cleanupTempDirs`) and the `closeApp()` decision matrix
(`classifyCloseFailure`) are all unit-tested in `e2e/helpers/*.test.ts` with injected fs/clock —
including a deliberately leaked directory being **reported**, a **loud** write failure, an
untracked allocation still being registered, and the full `2×2×2` decision matrix. The old
"harness reclaims the temp dirs it allocated" e2e case was pure fs logic (its own comment said "No
Electron launch needed") and was moved down to the unit layer after a mutation check; only the
app-owned `will-quit` removal stays in e2e because it needs a real Electron quit. The deleter's
retry script is driven in a `vm` by `temp-cleanup.test.ts`, and `resetAppState` (the serial-mode
reset) is unit-tested in `e2e/helpers/reset.test.ts` while `e2e/guards/serial-reset.test.ts` keeps
the "every serial spec resets in `beforeEach`" convention executable. The e2e gate spec only
orchestrates; it must never be the only place that can prove the gate can go red.

This pins the production side too: `will-quit` runs its cleanup synchronously and _first_, before
the awaited `stopFolderWatching()`, and `closeApp()` throws on a quit timeout instead of reporting
a silent "closed". A normal exit that leaks is now a defect that CI sees.

## The OS clipboard is its own Playwright project

Playwright cannot intercept the real clipboard, and mocking it would defeat the point of the specs
that use it (a real copy event producing a real payload). That makes those tests destructive by
nature: they overwrite whatever the user has copied and write it back afterwards, and a run
interrupted mid-test leaves the test payload behind.

So they run only where that cost buys something. The six specs that touch the clipboard
(`select-all-copy-fidelity`, `pane-toolbars`, `preload-contract`, `formula-copy-image`,
`copy-once-no-drop-diagrams`, `context-menu`) live **exclusively** in `e2e/clipboard/`, which is the
`testDir` of the **`e2e-clipboard`** project — the only project that sets the `clipboardE2e`
option (`e2e/helpers/fixtures.ts`). No other project collects those files, so `npm run e2e:app`
cannot touch the user's clipboard; "one spec file, one project" is pinned by ADR-0034.

```bash
npm run e2e:app        # never collects e2e/clipboard/ — no clipboard writes at all
npm run e2e:clipboard  # runs the 21 real-clipboard cases; CI does too via `e2e:full`
```

The destructive lifecycle — gate → launch → snapshot → restore → close — lives in **one** place, the
`clipboardApp` fixture in `e2e/helpers/fixtures.ts`. Getting that order wrong is the one failure in
this suite that damages something outside the repository, so it must not be copied into six specs
(where it had already drifted apart: three skipped before launching the app, three launched first
and snapshotted conditionally). Each spec takes the app from that fixture and does nothing else:

```ts
let handle: AppHandle
test.beforeEach(async ({ clipboardApp }) => {
  handle = clipboardApp
})
```

The fixture skips the test when the option is off, so a spec cannot reach the clipboard in a project
that is not allowed to write it; it snapshots the clipboard before the app can change anything,
restores that snapshot afterwards (also when the test failed), and closes the app last.

The guards under `e2e/guards/` are the source of truth for which convention each locks; see
`## Contract guards` for the shape their assertions take.

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

## Choosing the test layer

Put a case at the lowest layer that can catch the bug it guards. A unit test with a
pure function, the in-memory `createMemoryDiskIO()` fake, or a jsdom render fails
faster and points closer to the cause than launching the app, so reach for a higher
layer only when the behaviour under test does not happen at the lower one. This keeps
the expensive layers thin — a guideline about feedback speed, not a quota for how many
cases each layer holds.

Ask what a case actually verifies before asking whether a unit test could go red for
the same bug. A stub can supply the asserted value (an OS colour preference, a mocked
clipboard) but cannot prove the real path reached the code; that is why ADR-0033 lists
both Unit locks and E2E locks, and why "one mutation cannot speak for two behaviours".
A feature having unit coverage therefore does not settle where its e2e case belongs.

When an e2e case is a candidate for removal, decide which situation applies:

- **The behaviour still needs guarding.** Cover it at the lowest layer that can produce
  the asserted value, and use a mutation check to prove the replacement goes red when
  the fix is reverted and green again when it is restored (see "Regression tests must
  be able to fail"). If it stays green, record that as "this scenario did not reach the
  failure path in that run" — never as "it cannot fail" — and keep the e2e case while
  the reproduction rate is raised.
- **The case no longer verifies anything** — it cannot fail, duplicates another case,
  or the behaviour it guarded is gone. Remove it without inventing a replacement test,
  and record which of those reasons applies in the change.

A flaky e2e is evidence: raise the reproduction rate before downgrading the test.

### Reducing e2e cost without losing coverage

The expensive part of an e2e case is the Electron launch, not its assertions. When a file has
many small cases, reduce launches rather than delete assertions (ADR-0035). Two patterns:

- **Independent read-only cases:** one `test()` with `test.step()` segments and a single
  `beforeAll`/`afterAll` launch. Order steps so earlier ones cannot pollute later ones.
- **Stateful cases:** keep independent `test()` cases, add
  `test.describe.configure({ mode: 'serial' })`, launch once in `beforeAll`, and call the shared
  `e2e/helpers/reset.ts` helper in `beforeEach`. A single mega-test is NOT an acceptable
  alternative: the first failing step would abort every later assertion. Serial mode also means a
  retry re-runs the whole group from `beforeAll` — verify the group still passes with
  `--retries=0` before relying on it.

The reset must cover both processes — `page.reload()` only rebuilds the renderer, while documents,
workspace root, viewport **and main-process monkey patches** live outside it. `resetAppState()`
therefore deletes all documents, clears the workspace root, restores the standard viewport,
restores `dialog.showMessageBox` (confirm spies are installed in the MAIN process and a page reload
does not undo them), clears both confirm-call recorders — otherwise a previous case's recorded call
makes `.poll(calls.length).toBeGreaterThan(0)` pass vacuously — and finally reloads. This
reproduces the per-test user-data-dir isolation documented in `e2e/helpers/launch.ts`. Any spec
using the serial pattern MUST call the helper; adding a case that sets main-process state without
extending the helper will leak into later cases.

### Concurrency of reused instances

`fullyParallel: false` means cases are serial **within a file** and parallel **across files**. A
reused instance is therefore never accessed by two workers at once, and each spec file still gets
its own Electron process with its own user-data-dir. Serial mode does change two things to be aware
of: a failing case skips the rest of its group, and CI's `retries: 1` re-runs the whole group from
`beforeAll` (verified: hooks stay paired, no leaked process). Verify groups with `--retries=0`
first. Cross-file parallelism is unaffected — a full `--project=e2e-app` run with the default
worker pool passes with the merged and unmerged specs interleaved.

## Contract guards

A _contract guard_ (see Glossary) follows four rules.

**Keep contract guards in the Vitest suite.** They inherit assertions, failure output, reporting
and watch; a separate CI script has to rebuild those and then needs a guard of its own.

**Assert the logic you wrote.** When you add or change logic in a config file — arithmetic,
environment branching, path composition — keep it in an exported pure function a unit test can
call. Asserting that Playwright APPLIES `timeout`, `retries` or `trace` is the framework's own
contract; restating it goes red on an upgrade that changed nothing you own. Pinning the values WE
wrote into the config is a different act, covered by the next rule.

**Pin a value only when you can name where the number came from besides this file.** A figure
calibrated in a decision record or a frozen baseline has that provenance and stays pinned; a figure
whose only source is the line being asserted is a change detector. Prefer a relation where one
exists ("at most one retry", "the budget follows the machine's parallelism"), and prefer a floor
over an exact count where the count only ever grows.

**Choose the assertion shape in this order:** an imported object or exported declaration → a parsed
structure (config object, workflow argv, JSON) → a narrow extraction from source text → an
occurrence count. A failure message names the convention broken and the repair.

**A guard is finished when:**

- A mutation turns it red and restoring turns green (see _mutation check_).
- Every collection it iterates carries an explicit expectation. `[].every(...)` is `true` and a
  zero-iteration loop is silent, so a vacuous guard passes by default.
- Its patterns describe the current repository. A regex naming a renamed directory, a glob handed
  to `new RegExp`, or a snapshot recorded from a broken state cannot fail.
- Every invariant a decision record lists as "must not change" has either an executable check or a
  recorded reason for having none.
- Comments describe only what the assertion detects; an exclusion guaranteed by structure is
  documented as structure.

## Regression tests must be able to fail

A test that locks a bug needs a **positive** assertion that the operation under test actually
happened, not only a negative assertion that the bad state is absent. A shortcut that never reaches
the app, or a listener that never fires, would otherwise leave "the bad state is absent" passing
vacuously. For example: assert the editor text changed after the first Ctrl+Z before asserting it
never becomes the previous document; assert the preview really reached `dark` before asserting it
turns `light`.

Follow `CONTRIBUTING.md` ("add tests first"): reproduce the failure, then fix it. When a regression
is covered only by an e2e test added after the fix, a one-off mutation check is the evidence that
it really guards the behaviour — temporarily revert the fix, confirm the test goes red, restore
the fix, and confirm it goes green again. Restore every stubbed global afterwards (see the table
above).

A mutation check that does **not** turn a test red must be recorded, not ignored. Record it as "this
scenario did not reach the failure path in that run" — never as "it cannot fail", because those are
different claims. **Todo ① is the cautionary tale.** Reverting the undo-history fix (2026-11-04)
turned both unit tests red but left the `document-lifecycle` Ctrl+Z e2e green, which led to the WRONG
conclusion that the case could not exercise the failure path and was only a smoke test. On
2026-11-05 a diagnosing-bugs loop (`--repeat-each=10 --workers=6`, ~32s) reproduced the exact
symptom 8/10. Two probes isolated it: the NEW document's buffer was already polluted on arrival,
before any Ctrl+Z; and a tagged switch trace showed the sync effect being fed the PREVIOUS
document's text as a same-document `content` refresh right after a clean `isDocSwitch` write. Root
cause: the 400ms `debouncedOnChange` carried correctness state and outlived its document, so a
keystroke in A fired AFTER the switch and wrote A's text into B's draft. The same debounce also
delayed `dirty`, the unsaved-buffer registry and the text Save reads — a switch or Ctrl+S inside
those 400ms silently lost the edit because the unsaved-changes guard never saw it.

**Final design (ADR-0033)** replaced the interim docId-tagging fix: each document now owns an
editing session (`AbortController` + its own debounce), rotated by a synchronous store subscription
before React commits. Correctness state is committed on the keystroke frame via
`onImmediateChange(text)`; the debounce only refreshes the preview and checks the signal before
emitting. Callback signatures are plain text — **no docId, no identity comparison** — which is the
mechanical acceptance check for the isolation. `docId` remains only a registry key and a switch
signal. The loop went 10/10 green again with this design. Unit locks: "commits the keystroke on its
own frame and debounces only the preview", "emits plain-text callbacks with NO document id",
"drops a debounced change that belongs to the PREVIOUS document", "never feeds the PREVIOUS
document draft to the editor mid-switch", plus the `useLocalDocument` frame-commit and
`debounce.cancel()` cases. E2E locks: keystroke-frame `dirty`/registry and the guard firing inside
the debounce window. Lesson: a flaky e2e is evidence — raise the reproduction rate before
downgrading the test.
Todo ② and ③ turn red in both axes under the same procedure.

Measured 2026-11-04 (second round, the focus hand-off) — both directions were mutated separately,
because one mutation cannot speak for two behaviours:

- **Fold → "…"** (todo ④, first half): making the hand-off effect never re-run turns
  "folding a focused command keeps keyboard focus reachable" RED (`activeId` stays null, the focus
  never reaches `editor-overflow-btn`). jsdom backs it with a case that unmounts the focused
  command the way React does.
- **"…" gone → first inline command** (todo ④, second half, measured 2026-11-05): disabling ONLY the
  widen branch (`visible >= total` → `visible > total`, so the hand-off cannot fire when the trigger
  disappears) turns the SAME e2e RED at its widen step (`expect.poll(activeId).toBe('fmt-# -')`
  in `e2e/app/pane-toolbars.e2e.spec.ts`) while its fold step passes — so the two directions are
  pinned by two independent mutations, not by one shared red.
- **A focus outside the bar** (todo ⑤): disabling the stale-focus guard turns "a focus in the
  editor pane is not pulled into the toolbar when a command folds" RED
  (`Expected: focused / Received: inactive`). The same mutation leaves the fold case GREEN, which
  is expected — removing the guard does not disable the hand-off — so that green run proves
  nothing and is not cited as coverage.
- **A remembered index outside the command set**: removing the `tracked < total` precondition
  turns "ignores a remembered command index that no longer exists in the command set" RED (the
  caret is reclaimed by the "…" trigger).

The first version of the "not pulled into the toolbar" case focused `fmt-# -`, the highest-priority
command, which is never folded at the width the case used — it could not fail — and it was
rewritten to focus the undo button, which the 200px column does fold away.

Measured 2026-11-06 (review round over the whole session-isolation change, standards axis and spec
axis as two independent passes) — three defects that no existing test could see, all now locked:

- **The keystroke-frame commit bypassed the session.** `onImmediateChange(text)` does not go through
  the debounce, so aborting the session protected the PREVIEW but not the authoritative write: a
  keystroke landing between "the store switched" and "the view was updated" still carried the
  PREVIOUS document's text into the new document's draft. The session now owns the WRITE as well —
  it remembers the text it last wrote into the view, and a keystroke is committed only when it was
  applied to exactly that text (a check that needs no identifier). Mutation evidence: replacing
  that ownership comparison with a constant turns "does not commit a keystroke that lands after the
  session was rotated by a switch" RED at `expect(onImmediateChange).not.toHaveBeenCalled()`.
- **A test that could not fail.** `useSearch.test.tsx`'s debounce case bumped the revision BEFORE
  the hook was mounted, so the subscriber never saw the bump, the 300ms timer never fired, and the
  case asserted nothing. It now bumps the revision after the mount and asserts that the settled
  snapshot reaches the query.
- **A timing gate measured on a loaded machine.** `playwright.config.ts` claimed "Playwright runs
  PROJECTS sequentially (each project is its own phase)". That premise was false: three specs in two
  projects ran on three workers and finished in 12.7s of wall clock while their own durations
  summed to 21.1s — they overlapped. `e2e-perf-gate` therefore shared the machine with the 297
  e2e-app specs and measured 1602ms against its 1500ms threshold, while the SAME build measured
  712ms in an invocation of its own (478/541/647 across idle runs). The gate now runs in its OWN
  invocation — `npm run e2e:full` chains two, the CI serial job splits into two steps — and
  `e2e/guards/e2e-parallelism.test.ts` pins THAT property instead of the project ORDER, which never
  guaranteed anything. The threshold was NOT relaxed: the app is still ~3x faster than the frozen
  2644ms baseline. ADR-0027's own contingency ("if Playwright ever parallelised projects, the
  clipboard and perf suites would need their own invocations") is what this implements.

  One caveat worth knowing: the html/junit reporters are enabled **only when `CI` is set**
  (`reporter: process.env.CI ? [...] : 'list'`), so locally no report is written at all and a
  "the second run did not overwrite the report" check is vacuous. The A/B that actually proves the
  `--reporter=line` guard has to run with `CI=1`: with the flag, `playwright-report/index.html` and
  `reports/e2e/junit.xml` keep their timestamps; without it, both are rewritten (measured
  2026-11-06, 01:09:26 → 01:10:25).

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

| Environment | Size        | What it exercises                                                                              |
| ----------- | ----------- | ---------------------------------------------------------------------------------------------- |
| `standard`  | 1024 × 768  | the default: the editor toolbar is PARTIALLY overflowed (pane 368 < 472)                       |
| `wide`      | 1280 × 900  | every editor command is INLINE (pane 496 >= 472)                                               |
| `narrow`    | 800 × 600   | the narrow fixture size (at the app's window floor); MORE commands are in "…" (pane 256 < 472) |
| `baseline`  | 2560 × 1440 | the E9 visual baselines (the bars are 2272px / 1136px wide)                                    |

Entering an environment is per CASE, not per file: a spec that needs a different window gets its own
test case for it, while the case that stays in the default environment keeps asserting the default
layout. `e2e/app/pane-toolbars.e2e.spec.ts` has both — one case asserts the split-mode ownership in
the default (partially overflowed) environment, and a second, dedicated case enters `wide` to assert
the fully expanded format cluster.

The sizes are not free choices: they follow from the window floor (800), the sidebar default (288)
and the bar's all-inline width (`ALL_INLINE_AT` 472), so in split mode the pane is `(width - 288) / 2`.
`e2e/guards/viewports.test.ts` parses those constants out of the sources of truth and asserts the
contract — that `standard` really overflows, `wide` really fits every command inline, `narrow`
overflows even more commands than `standard`, and no environment is narrower than the app can be. A
layout change that invalidates an
environment therefore fails a unit test, not an e2e timeout far from the cause. The same guard also
protects the convention itself: that `e2e/helpers/launch.ts` still pins the standard environment for
every spec (deleting that call would silently make the whole suite host-dependent again, with
nothing else failing), that no spec types a viewport size of its own instead of entering a named
environment, and that the committed E9 visual baselines still match the geometry of the `baseline`
environment.

## Glossary

Test-infrastructure terms used above.

- **contract guard**: a Vitest-collected `*.test.ts` that locks a repository convention — which
  project owns a spec, which invocations CI runs, which values a decision record froze — rather
  than application behaviour. _Avoid_: "unit test of the config", "policy script".
- **mutation check**: a one-off, manual check — break the behaviour under test,
  confirm the test goes red, restore it, and confirm green again. Evidence that this
  test can fail, not a coverage number; distinct from automated mutation testing
  (seeded mutants, a mutation score). _Avoid_: "proves it cannot fail".
  See "Regression tests must be able to fail" for the full procedure.
- **viewport (e2e)**: the web **content area** the app renders into — what `page.setViewportSize()`
  sets. Distinct from the OS window's outer frame (title bar + borders). All width-coupled layout is
  driven by the content area, never the OS frame. _Avoid_: window size, OS window.
- **named environment**: one of the `VIEWPORTS` entries in `e2e/helpers/viewports.ts`
  (`standard`, `wide`, `narrow`, `baseline`) — a shared, reviewed width decision a spec enters by name
  instead of typing a literal pixel size. _Avoid_: custom size, magic number.
- **content area vs OS window**: the content area is the layout viewport (`setViewportSize` controls
  it); the OS window is the outer frame around it. Pinning the content area is deterministic; pinning
  the OS window is not, because the frame varies by platform, theme, and DPI.
- **residue gate**: a teardown-time project that fails a run when a temp directory that run
  allocated still exists. _Avoid_: sweeper, startup cleanup, `%TEMP%` scan.
- **run-scoped registry**: the on-disk, per-worker list of temp directories the current run
  allocated; the residue gate's only input. _Avoid_: global temp-dir listing, residue sweep.
- **teardown project**: a project reached only through another project's `teardown:` field, unless
  an npm script names it explicitly to keep a guard's project-name set in sync (ADR-0036); it
  runs after that project, and its failure is a real test failure. _Avoid_: globalTeardown,
  dependency project.
- **sweeper**: cleanup that deletes directories it did not allocate, inferring ownership from a
  name prefix or age. Rejected (ADR-0017). A **verifier** checks only paths it registered;
  a sweeper guesses. _Avoid_: residue gate, cleanup-on-startup.

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
