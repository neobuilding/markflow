# ADR-0004: Per-file 100% coverage gate on the unit-testable surface

- **Status:** Accepted

## Context

The security-critical Markdown rendering/sanitization logic deserves strong regression protection. But a
large fraction of the codebase (React components, the Electron main process, workers, CodeMirror) is
DOM/native integration code that is painful or impossible to unit-test meaningfully. A single aggregate
coverage threshold would either force pointless tests or let the important logic slip below 100%.

## Decision

`npm run test:coverage` (the CI `ut` job, after the `quality` job passes) enforces **100%** on the
repository's **unit-testable logic surface**, with `perFile: true`:

- Statements / branches / functions / lines all at 100%, and **every individual file** in `vitest.include`
  must hit 100% (not just the project aggregate).
- The DOM / native integration surface (React components, Electron main process, workers, CodeMirror, …) is
  held out via `coverage.exclude` and validated by other means (e2e, typecheck), so it is outside this gate.

When the gate goes red, the resolution order is mandated:

1. **Extend tests first** — cover the missing branch/statement to 100%.
2. **Delete genuinely unreachable dead code** — an unreachable `else` from a constant-true condition is
   deleted, not ignored.
3. **Last resort — `v8 ignore` with a comment** — only when a block is both unreachable under unit tests
   and undeletable (e.g. `import.meta.env.DEV`, a process-entry/child-process boundary). The comment must
   state why it is unreachable, why it cannot be deleted, and what other means validate it.

## Consequences

- **Positive:** the core logic (parser + sanitizer + stores) has maximum regression confidence.
- **Positive:** the escape hatch exists but is self-documenting and rare.
- **Negative:** contributors must extend tests (or delete dead code) rather than reach for `v8 ignore`; this
  is enforced, not optional.
- **Negative:** per-file strictness makes the gate "red" on any single uncovered branch, raising the bar for
  every PR touching the logic surface.
