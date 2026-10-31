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

Coverage of the same handler boundary that needs no real clipboard lives in
`electron/main/handlers/app.test.ts` (mocked `clipboard`, `ClipboardItem` from the electron export).

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
plain JS shipped as a bundle, so annotating it would be a rewrite — what is still checked there is
syntax, import resolution and ESM/CJS shape, which is what breaks silently in a script nobody runs
locally.

Two traps that let files escape the gates, both closed — keep them in mind before moving files:

- **An `include` pattern with no program behind it checks nothing.** `tsconfig.tests.json` listed
  `scripts/**/*.mjs` while `allowJs` was off, so those files were parsed by nobody.
- **TypeScript 7 drops a `*.tsx` that has a same-named `*.ts` sibling** during include expansion
  (verified with a two-file repro). That is why `store/ui.test.tsx` is listed in `files` rather than
  reached by the `**/*.tsx` pattern. Avoid creating same-basename `.ts`/`.tsx` pairs.

On the lint side, `eslint .` covers every JS/TS file except `*.d.ts` (ambient or generated
declarations). Config files used to be ignored wholesale via `**/*.config.ts`; they are linted now,
with `tsconfig.tests.json` as their type gate.

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
