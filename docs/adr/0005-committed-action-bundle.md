# ADR-0005: Committed GitHub Action bundle

- **Status:** Accepted

## Context

`actions/create-pr` is a self-contained GitHub Action referenced from CI via `uses: ./actions/create-pr`.
GitHub requires a `uses:` reference to point at **checked-in code**, not a build step that runs at workflow
time. The action's runtime is `actions/create-pr/dist/index.mjs`, bundled from `actions/create-pr/src/`.

Beyond the committed bundle, the action was designed (phase 1, `plan-create-pr-github-action-done.md`) as a
**temporary tenant of this repo, structured for extraction into its own repo with zero refactor**: the
`actions/create-pr/` directory is fully self-contained (its own `package.json` with `@actions/core` as the
only runtime dep, `@vercel/ncc` as a build devDep; its own `README.md`; committed `dist/`). Dependencies
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

Commit `actions/create-pr/dist/index.mjs` alongside `actions/create-pr/src/`. After **any** change under
`actions/create-pr/src/`, run `npm run build:action` (ncc bundles `src/index.mjs` → `dist/index.mjs`) and
commit the rebuilt bundle together with the source change. Keep `core.mjs` pure and at 100% coverage; the
entry owns input parsing, token injection, and (post-generalization) block scanning.

## Consequences

- **Positive:** the action runs reproducibly in CI from a known, reviewed bundle, and can be lifted into its
  own repo by moving the directory — no refactor.
- **Negative:** a stale `dist/index.mjs` is a real failure mode — CI would ship old behavior. The
  rebuild-and-commit step is therefore **mandatory**, not optional; `npm run local-test-render` lets you
  preview the rendered PR body without a token or `gh`.
