# ADR-0005: Committed GitHub Action bundle

- **Status:** Accepted (amended 2026-09-13 — the bundle is no longer committed; it is built at workflow
  runtime. See the Amendment subsection in Decision.)

## Context

`actions/create-pr` is a self-contained GitHub Action referenced from CI via `uses: ./actions/create-pr`.
GitHub requires a `uses:` reference to point at **checked-in code** (the committed `action.yml` + `src/`);
the bundle itself is regenerated at workflow runtime (see Decision), not checked in. The action's runtime is
`actions/create-pr/dist/index.mjs`, produced by `ncc` from `actions/create-pr/src/index.mjs`.

Beyond the committed bundle, the action was designed (phase 1, `plan-create-pr-github-action-done.md`) as a
**temporary tenant of this repo, structured for extraction into its own repo with zero refactor**: the
`actions/create-pr/` directory is fully self-contained (its own `package.json` with `@actions/core` as the
only runtime dep, `@vercel/ncc` as a build devDep; its own `README.md`). `dist/` is git-ignored —
it is generated at workflow runtime. Dependencies
live in that directory, **not** in the root `package.json`.

Its core design principles (all implemented):

- **Core purity:** `core.mjs` reads no Action input, takes no token, and does no file/IO. Token is injected
  via `process.env.GH_TOKEN` by the `index.mjs` entry; `runMain` receives only logical params
  (`{ head, base, dryRun, templatePath, blocks }`). This keeps `core.mjs` pure and 100% unit-testable.
- **AUTO-block PR body:** the PR body is split by symmetric markers `<!-- AUTO:key --> … <!-- /AUTO:key -->`
  into segments (title / type / issue / checklist / commits). On refresh, each segment is **reset to the
  template** while content outside the markers (human-written Description / notes) is preserved. This makes
  PR refreshes idempotent.
- **Coverage:** `actions/create-pr/src/core.mjs` is held at **100%** (statements/branches/functions/lines);
  `index.mjs` (input parsing, file IO) is deliberately outside the coverage gate.
- **Token:** uses a PAT via `secrets.PR_TOKEN`, because GitHub's default `GITHUB_TOKEN` cannot create PRs in
  the same repo.

> **Not yet implemented:** the phase-2 "generalization" plan (`plan-generalize-create-pr-action-done.md`)
> redesigns the hardcoded 5-block / English-checkbox logic into two orthogonal primitives — **blocks**
> (directory-scanned `.mjs` plugins, built-in + user-repo same-shape) and **AUTO segments** — and drops the
> `.jsonc` config in favor of full pluginization. That plan is **designed but not yet applied**; this ADR
> records the implemented phase-1 shape and will be revisited when generalization lands.

## Decision

Do **not** commit `actions/create-pr/dist/index.mjs`. The bundle is produced from `actions/create-pr/src/`
at workflow runtime: `auto-pr.yml` runs `npm ci --prefix actions/create-pr` and `npm run build:action`
(ncc bundles `src/index.mjs` → `dist/index.mjs`) in a step **before** `uses: ./actions/create-pr`, so the
code the action executes is always freshly built from the committed `src/` and can never be stale. Contributors
edit only `src/` and never commit `dist/`; for local runs/tests, `npm run build:action` builds it on demand
(it is git-ignored). Keep `core.mjs` pure and at 100% coverage; the entry owns input parsing, token injection,
and (post-generalization) block scanning.

### Amendment (2026-09-13)

The original decision committed the bundle. That was reversed because a committed `dist/` reintroduced a
"stale bundle" failure mode that a rebuild-and-commit discipline could not reliably prevent, and it let
`auto-pr.yml` consume an outdated bundle on feature-branch pushes _before_ any CI gate ran. Building the
bundle at runtime removes the committed artifact entirely — there is nothing to drift. `dist/` is therefore
git-ignored again (see `.gitignore`). GitHub's "checked-in code" requirement is satisfied by the committed
`action.yml` + `src/`; the bundle is regenerated in-place in the workspace before `uses:` resolves it.

## Consequences

- **Positive:** contributors never commit a build artifact, and the action always runs a bundle regenerated
  from the reviewed `src/`, so it cannot execute outdated code. The action remains liftable into its own repo
  (move the directory; the consuming workflow builds the bundle before `uses:`). `npm run local-test-render`
  still previews the rendered PR body without a token or `gh`.
- **Negative (retired):** the old committed-bundle approach had a "stale `dist/index.mjs`" failure mode
  (CI could ship old behavior if a source change was not accompanied by a committed rebuild). Building at
  runtime eliminates that class of bug — there is no committed artifact to drift.
