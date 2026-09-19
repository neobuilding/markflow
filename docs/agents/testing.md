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
