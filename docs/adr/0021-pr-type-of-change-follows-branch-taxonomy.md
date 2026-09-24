---
status: accepted
date: 2026-09-24
deciders: grill-with-docs session (create-pr Type-of-Change expansion)
---

# ADR-0021: PR "Type of Change" boxes follow the branch taxonomy, with a Breaking overlay

The create-pr action renders the `{{types}}` block of the PR template from a repo-side
plugin (`.github/create-pr/blocks/types.mjs`). The plugin **owns** the classification:
it reads the branch name (`ctx.head`) and the commit subjects (`ctx.services.git.logSubjects`)
and derives the flags itself via `classifyChange`. The render core never computes the
type and never exposes a `ctx.typeFlags` field — see ADR-0022 for the unified
core↔plugin contract that moved this logic out of the core.

## Why it changed

The block originally carried four impact-axis boxes — Bug fix / New feature / Breaking
change / Documentation update — which encode _user-facing impact_ (keep-a-changelog
style). The repo's branch taxonomy in `auto-pr.yml`, however, is a _work-type_ axis:
`feature / fix / ci / chore / docs / refactor / build / test / perf`. The two axes do
not line up: a `refactor/`, `test/`, `ci/`, `build/`, `chore/`, or `perf/` branch had
no matching box and was silently folded into the "Bug fix" safe default, which is wrong.
The user asked to expand the types to cover refactoring, tests, technical improvement,
and documentation changes.

## Decision

The block now lists seven self-ticking checkboxes:

1. Bug fix
2. New feature
3. Refactor
4. Tests
5. Performance / technical improvement — aggregates the non-user-facing internal work
   types `perf`, `ci`, `build`, `chore` into one `improvement` flag (per the user's
   decision that `ci`/`build`/`chore` belong to "技术改进").
6. Documentation update
7. Breaking change — an **overlay** that can sit on top of any work-type box (a refactor
   or build can still break an API); it is not part of the "exactly one work type" set.

`classifyChange` detects each flag from **two** signals:

- the branch _prefix_ (the segment before the first `/`), mapped through a table that
  mirrors `auto-pr.yml`'s prefixes; and
- conventional-commit _types_ at the start of each commit subject (`fix:`, `feat(scope):`,
  `refactor!:`, …).

`breaking` is detected from the `!:` conventional-commit marker or the words "break" /
"breaking" anywhere. When no work-type box matches, Bug fix remains the safe default.

## Considered Options

- **Branch taxonomy + Breaking overlay (adopted).** The seven boxes above. Detection is
  prefix- and conventional-commit-based, which avoids the substring false positive where a
  branch like `feature/pipeline-test-improves` would otherwise tick "Tests" just because
  the word "test" appears mid-name.
- **Pure work-type, drop Breaking (rejected).** Losing the impact overlay throws away the
  useful "this PR breaks APIs" signal that any work type can carry.
- **Keep the impact axis and merely append new boxes (rejected).** Mixing "Bug fix /
  New feature / Breaking / Docs" (impact) with "Refactor / Tests / Technical improvement"
  (work type) in one flat list produces two contradictory semantics in a single block.

## Consequences

- Every branch prefix enforced by `auto-pr.yml` now maps to a visible, auto-ticked box;
  no branch type silently collapses to Bug fix.
- `classifyChange` returns seven keys (`bug / feature / refactor / test / improvement /
docs / breaking`); any consumer or test asserting the old four-key shape must be updated.
- The classification logic lives IN the `types` plugin (`.github/create-pr/blocks/types.mjs`,
  inline) as the canonical, user-editable source — the action core (`src/`) contains NO
  classification module. The test fixture `.github/create-pr/blocks/__tests__/fixtures/types.mjs`
  mirrors it (keep the two in lock-step) and is loaded via `loader.mjs` so the placeholder⇄plugin
  alignment is exercised without touching the real filesystem. The bundled `issue` plugin inlines
  `extractFixes` the same way. So neither classification nor issue-extraction logic lives in `src/`
  core.
- `Breaking change` is genuinely multi-select: a `refactor!: …` commit ticks both Refactor
  and Breaking.
- Coverage gate (ADR-0004) holds: every new branch in `classifyChange` is exercised by the
  expanded unit tests, including the "type outside the taxonomy" and "nothing matches"
  fallback branches.
- Implementation (post-refactor, see ADR-0022): the classification moved out of the render
  core into the plugin, and there is no core classification module. `classifyChange`/`extractFixes`
  are inlined inside the `types` / `issue` plugins (no `src/classify.mjs`); `buildCtx` no longer
  pre-computes `typeFlags` or `fixes`, and the core is ignorant of "PR type" entirely.
