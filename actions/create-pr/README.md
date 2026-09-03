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
  `<!-- AUTO:key --> ... <!-- /AUTO:key -->`. The block **keys are discovered
  dynamically** from the template — any `<!-- AUTO:x -->` marker becomes a block,
  so the action adapts to any repo's PR template instead of hard-coding a fixed
  set. Human-written content outside the blocks (Description, notes) is preserved
  verbatim.
- Each block may contain `{{placeholder}}` tokens. A token is rendered by a
  **block plugin** — a `(ctx) => string` generator looked up in the block
  registry. Built-in plugins (`title` / `issue` / `commits`) ship with the
  action; users may add their own (e.g. `types`) in `.github/create-pr/blocks/`.
  A token with no matching plugin is left untouched (`{{name}}` stays verbatim),
  so a missing plugin never drops or corrupts content.
- Derives the PR title from the branch name (`feature/*`, `fix/*`, etc.).

## Block plugin mechanism

The action is **fully plugin-based** (no declarative config). There is a single,
uniform extension mechanism: a directory of `*.mjs` files.

- **Built-in blocks** (shipped with the action and bundled into `dist/index.mjs`):
  - `title` — renders the PR title (derived from the branch name).
  - `issue` — renders the linked issue number, or `N/A` when none is referenced.
  - `commits` — renders the `base..HEAD` commit list.
- **Custom blocks**: drop a `.mjs` file in `.github/create-pr/blocks/` of your
  repo. Each file exports a default function `export default (ctx) => string`,
  and the **file name (minus `.mjs`) is the block name** used as the
  `{{placeholder}}` in your template. Custom blocks are loaded _after_ the
  built-ins, so a same-named file overrides a built-in.

The `ctx` passed to every plugin includes: `head` (branch name), `base` (resolved
base ref), `title`, `fixes` (extracted issue number), `typeFlags` (derived by
`classifyChange`: `bug` / `feature` / `breaking` / `docs`), and `commits`.

Example — a repo-provided `types.mjs` plugin that generates the "Type of Change"
checkboxes (the action core never hard-codes any checkbox wording):

```js
// .github/create-pr/blocks/types.mjs
export default (ctx) => {
  const f = ctx.typeFlags || {}
  const row = (label, on) => `- [${on ? 'x' : ' '}] ${label}`
  return [
    row('Bug fix (non-breaking change which fixes an issue)', f.bug),
    row('New feature (non-breaking change which adds functionality)', f.feature),
    row(
      'Breaking change (fix or feature that would cause existing functionality to not work as expected)',
      f.breaking,
    ),
    row('Documentation update', f.docs),
  ].join('\n')
}
```

With the template containing:

```markdown
<!-- AUTO:type -->

## Type of Change

{{types}}
<!-- /AUTO:type -->
```

The action refreshes the block on every run, re-rendering `{{types}}` from the
current branch/commits. Blocks with **no** `{{placeholder}}` (like the
Checklist) are simply copied verbatim, which resets them to the template state.

A template with **no** `<!-- AUTO:x -->` markers at all is used verbatim as the
PR body (no block rendering), so plain templates still "just create a PR".

## Inputs

- `head` (optional): Head branch. Defaults to `github.head_ref` / `github.ref_name`.
  An explicit input wins; otherwise the action falls back to GitHub's refs.
- `base` (optional, default `main`): Base branch.
- `dry-run` (optional, default `false`): Print the body without writing.
- `template` (optional, default `.github/pull-request-template.md`): Path to the
  PR template (override for custom repos).
- `blocks-dir` (optional, default `.github/create-pr/blocks`): Directory of
  user-provided block plugins (relative paths are resolved from the repo root).
  Same-named files override the built-in blocks. Set to an empty/absent
  directory to use only the built-in blocks.
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
npm run local-test-render   # preview the rendered PR body for a branch (no token, no gh)
```

In the host `markflow` repo, `npm run build:action` triggers the same build via
the local `actions/create-pr` package, and `npm run test:coverage` exercises the unit
tests through the root vitest config (which points at `actions/create-pr/src`).

The bundled `dist/index.mjs` is committed on purpose (GitHub requires it for a
direct `uses:` reference) and must be rebuilt after any change to `src/`.

### Local rendering (no token, no gh)

All rendering goes through a single module, `src/render-template.mjs`
(`renderTemplate`). `src/cli-render.mjs` is just a thin wrapper over it: it
parses CLI flags, reads the template (and optional existing body) into strings,
and prints the result. Both the GitHub Action (`src/index.mjs`) and local
previews call the same `renderTemplate`, so what you preview locally is exactly
what the Action would put in the PR.

To preview the **fresh** PR body a given branch would produce, without any
GitHub token or `gh` CLI, run the rendering CLI from the repo root:

```bash
node actions/create-pr/src/cli-render.mjs --head feature/my-branch
# Optional: --base main, --template .github/pull-request-template.md,
#           --blocks-dir .github/create-pr/blocks, --no-git
```

The repo also wires this up as a convenience script so you don't have to type
the path. Both `package.json` files expose the same `local-test-render` script;
the only difference is which `package.json` runs it (and thus how the path is
resolved):

- **From the repo root** (`markflow/package.json`):
  `npm run local-test-render` → `node actions/create-pr/src/cli-render.mjs --head feature/my-branch`
  (the template defaults to `.github/pull-request-template.md` via `cli-render`'s
  own default, so `--template` is omitted).
- **From inside `actions/create-pr`** (`actions/create-pr/package.json`):
  `npm run local-test-render` → `node src/cli-render.mjs --template ./../../.github/pull-request-template.md --head feature/my-branch`
  (it passes the real template path explicitly, relative to the action dir).

Both resolve `feature/my-branch` against the default template and print the
rendered body. Run either one — they produce the same output.

It reads the template file, loads the block plugins, and derives the title /
change type from the branch name. Per the plugin-autonomy rule, the renderer
only injects the services into the render context — it does NOT fetch commits
itself. The `commits` block plugin pulls the real `git log <base>..HEAD` from
`ctx.services.git` on its own. Pass `--no-git` to skip the git service entirely
and render `{{commits}}` empty (handy on machines without git, or to just
inspect the template structure).

#### Previewing a _refresh_ (existing PR) render

"Refresh" means merging the freshly rendered body into an **existing** PR body
(the action keeps human-written text outside the `<!-- AUTO:… -->` blocks and
only updates the blocks in place). The merge is part of `renderTemplate`, so you
preview a refresh in one step by passing the existing body via `--existing`:

```bash
node actions/create-pr/src/cli-render.mjs \
  --head feature/my-branch \
  --existing /path/to/current-pr-body.md
# Optional: --base main, --template .github/pull-request-template.md,
#           --blocks-dir .github/create-pr/blocks, --no-git
```

This shows exactly what the action would write back to GitHub on a refresh
(`action: 'updated'`), without needing a token, `gh`, or a live PR. The refresh
merge is a pure, local operation — `renderTemplate` refreshes each AUTO block in
place and preserves human-written text outside the blocks.
