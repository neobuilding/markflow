# Create / Refresh PR

A self-contained JavaScript GitHub Action that idempotently creates or refreshes
a Pull Request from a head branch into `main`, using the repository's PR
template and AUTO-block body management.

> This directory is designed to be extracted into its own Action repository. It
> is currently hosted temporarily inside the `markflow` repo under
> `actions/create-pr/` and referenced via `uses: ./actions/create-pr` in the
> CI workflow. Extracting it later means copying this whole directory — no
> refactoring required.

## What it does

- Opens (or refreshes) a PR via the GitHub CLI (`gh`) using the repo's PR
  template (default `.github/pull-request-template.md`).
- Does **not** push. The head branch must already exist on `origin`.
- Idempotent: if a PR for the head branch already exists, it is refreshed (not
  re-created). Re-running on the same commits is a no-op.
- Splits the PR body into independent auto blocks marked with
  `<!-- AUTO:key --> ... <!-- /AUTO:key -->` (`title` / `type` / `issue` /
  `checklist` / `commits`). Each block is refreshed from the template on every
  run, while human-written content outside the blocks (Description, notes) is
  preserved verbatim.
- Derives the PR title from the branch name (`feature/*`, `fix/*`, etc.) and
  auto-ticks the "Type of Change" boxes.

## Inputs

- `head` (optional): Head branch. Defaults to `github.head_ref` / `github.ref_name`.
  An explicit input wins; otherwise the action falls back to GitHub's refs.
- `base` (optional, default `main`): Base branch.
- `dry-run` (optional, default `false`): Print the body without writing.
- `template` (optional, default `.github/pull-request-template.md`): Path to the
  PR template (override for custom repos).
- `token` (required): GH token (PAT with `repo` scope). `GITHUB_TOKEN` cannot
  create PRs.

## Usage

```yaml
- name: Create / refresh PR
  uses: ./actions/create-pr
  with:
    head: ${{ github.ref_name }}
    base: main
    token: ${{ secrets.PR_TOKEN }}
```

## How `token` works

The default `GITHUB_TOKEN` is forbidden from creating PRs in the same repo, so
the action expects a Personal Access Token stored as a secret (e.g.
`PR_TOKEN`) with the `repo` scope. The entry point injects it into
`process.env.GH_TOKEN` so that the `gh` calls inside the core logic
authenticate. The core never learns where the token came from.

## Development

This directory is self-contained (its own `package.json`). To build or test it
in isolation:

```bash
cd actions/create-pr
npm install          # installs @actions/core, @vercel/ncc, vitest locally
npm run build        # ncc bundles src/index.mjs -> dist/index.mjs
npm test             # runs the unit tests with vitest
```

In the host `markflow` repo, `npm run build:action` triggers the same build via
the local `actions/create-pr` package, and `npm run ci` exercises the unit
tests through the root vitest config (which points at `actions/create-pr/src`).

The bundled `dist/index.mjs` is committed on purpose (GitHub requires it for a
direct `uses:` reference) and must be rebuilt after any change to `src/`.
