# ADR-0007: TypeScript 7 + side-by-side ESLint TypeScript 6 shim (transitional)

- **Status:** Accepted (transitional — remove once `typescript-eslint` supports TypeScript 7)

## Context

MarkFlow builds on **TypeScript 7**, but `typescript-eslint` v8 does not yet support TS7. ESLint is a
**hard gate** (`--max-warnings=0`), so the linter must understand the project's syntax to pass CI.

## Decision

The `postinstall` and `lint` scripts run `scripts/install-eslint-ts6.mjs`, which installs the **TS6
type-checker API alongside the project's TS7** purely for the linter (Microsoft's documented
"side-by-side" approach). The application runtime always uses TS7. This is explicitly documented as a
**temporary** transition; it is to be removed once `typescript-eslint` ships TS7 support.

## Consequences

- **Positive:** `npm run lint` passes today against TS7 source, with zero source changes for the
  workaround.
- **Negative:** an extra install step and a shim to maintain; the linter and the app intentionally run
  different TypeScript majors until the toolchain catches up.
- **Action:** when `typescript-eslint` supports TS7, delete `scripts/install-eslint-ts6.mjs` and the
  `postinstall`/`lint` hooks that invoke it.
