# Contributing to MarkFlow

Thanks for your interest in improving MarkFlow! This guide covers how to set up a
development environment, the conventions we follow, and how changes get released.

> 📖 For **product overview, features, and download instructions**, see the
> [README](README.md). This document is for **contributors**, not end users.

## Code of Conduct

By participating, you agree to uphold a respectful, harassment-free environment. See the
[Code of Conduct](.github/CODE_OF_CONDUCT.md) for details.

## Development Setup

### Prerequisites

- Node.js >= 22.22.2 — the floor is set by `jsdom` (`^22.22.2 || ^24.15.0 || >=26.0.0`) and
  `lint-staged` (`>=22.22.1`), not by an arbitrary choice.
- npm >= 9 — conservative floor: npm 9 writes `lockfileVersion: 3` by default (npm 7/8 can read it
  but rewrite it as v2), and `overrides` needs >= 8.3. No dependency declares an npm 9 requirement.

`package.json#engines` is the machine-readable declaration; `.nvmrc` is the single version
selector for local development and CI (all `actions/setup-node` steps use `node-version-file`).
`engine-strict` is intentionally **not** enabled: alongside the TS7 / `legacy-peer-deps`
transition it would fail every `npm ci` on an old 22.x runner instead of warning.

> 💡 No native toolchain is required: MarkFlow uses an in-memory document store and a
> pure-JS, index-free search scanner, so `npm install` works without a C++ compiler.

### Run the dev build

```bash
# Clone the repository
git clone https://github.com/yourusername/markflow.git
cd markflow

# Install dependencies
npm install

# Start development (Vite dev server + Electron)
npm run dev
```

## Project Structure

```
markflow/
├── electron/
│   ├── main/              # Electron main process
│   │   ├── model/        # In-memory document store
│   │   ├── ipc/          # IPC handlers (documents, search)
│   │   └── index.ts      # Main process entry
│   └── preload/          # Preload script (contextBridge)
├── src/renderer/
│   └── src/
│       ├── components/
│       │   ├── editor/   # Editor pane, CodeMirror, command palette
│       │   ├── preview/  # Markdown preview (KaTeX, Mermaid)
│       │   ├── sidebar/  # Document list, search
│       │   └── ui/       # Base UI components (Radix UI)
│       ├── hooks/         # TanStack Query hooks
│       ├── store/         # Zustand stores
│       ├── lib/           # Utilities
│       └── types/        # TypeScript types
├── resources/            # App icons, entitlements, etc.
├── release/              # Built applications (gitignored)
├── package.json
├── electron-builder.json5
├── vite.config.ts
└── tsconfig.json
```

## Tech Stack

| Layer             | Technology                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| Build             | Vite 8 + vite-plugin-electron                                                                                     |
| Desktop           | Electron 44                                                                                                       |
| Frontend          | React 19 + TypeScript (strict) + Tailwind CSS 4                                                                   |
| UI Components     | Radix UI primitives (shadcn/ui style)                                                                             |
| State             | Zustand (UI) + TanStack Query v5 (IPC)                                                                            |
| Storage           | In-memory document store (Map) + index-free literal/regex scanner + chokidar folder watcher + Markdown dual-write |
| Editor            | CodeMirror 6 with Markdown syntax highlighting                                                                    |
| Math              | KaTeX (LaTeX formula rendering)                                                                                   |
| Diagrams          | Mermaid.js                                                                                                        |
| Markdown parser   | markdown-it + plugins (GFM, KaTeX, GitHub Alerts, containers)                                                     |
| HTML sanitization | DOMPurify + branded `SanitizedHtml` type gate + single DOM write entry `patchPreviewContent` (single XSS point)   |
| Testing           | Vitest + jsdom                                                                                                    |
| Packaging         | electron-builder                                                                                                  |

## Coding Conventions

- **Commits**: follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `docs:`, `chore:`, `BREAKING CHANGE:` / `feat!:` …) to keep
  history readable. The base version in `package.json` is bumped manually at
  milestones; the rolling release suffix is generated automatically, so commit
  messages aren't required for versioning.
- **Type safety**: `npm run typecheck` must pass (no new `any` without reason).
- **Security**: every PR is scanned by **CodeQL** (`codeql.yml`). If it flags something,
  triage it rather than disabling the check.
- **Quality gates**: run `npm run quality` before pushing — it runs Prettier's format check,
  ESLint, Stylelint (CSS), Markdownlint (docs) and Secretlint (secrets). A Husky `pre-commit` hook runs
  lint-staged automatically. ESLint is a **hard gate** with zero warnings: `typescript-eslint` v8 still
  caps TypeScript at `<6.1.0`, so a `postinstall` shim (`scripts/install-eslint-ts6.mjs`) installs the TS6
  API alongside the project's TS7 for the linter only (Microsoft's documented "side-by-side" approach).
  A few new, opinionated `react-hooks` rules (`refs`, `set-state-in-effect`) are kept at `warn` because the
  code intentionally uses "latest-value ref" and effect-init patterns; the `preserve-caught-error` core rule
  is satisfied by attaching the original error via `Object.assign(new Error(...), { cause })`, which is
  type-safe under TS7 (whose `Error` type lacks the `options` overload) yet still preserves the cause at runtime.
- **Secrets**: never commit credentials. Secretlint scans the repo locally (`npm run lint:secret`)
  and in CI; CodeQL also runs on every PR.
- **Language**: source code, comments, commit messages, test code, and test fixtures (e2e
  fixtures under `e2e/fixtures/`) are **English only**. Chinese is reserved for human-facing prose
  (README, this file, ADRs, and the `CONTEXT.md` glossary that maps the app's localized UI
  strings). When adding demo/test documents, default to the `*.en.md` variant, not `*.zh-CN.md`.

## Testing

MarkFlow ships **Vitest** unit tests for the Markdown rendering subsystem (the
security-critical path: parser + single XSS sanitization gate). They run in
`jsdom` and are exercised on every push/PR by `ci.yml`.

```bash
# Run the full suite once (CI mode)
npm run test

# Watch mode during development
npm run test:watch
```

What's covered (see `src/renderer/src/lib/*.test.ts`):

- `markdownPipeline.test.ts` — GFM (task lists, strikethrough, tables), KaTeX
  (inline/block/currency `$` guard), Mermaid slot extraction, GitHub Alerts,
  custom containers, Frontmatter stripping, `appdoc://` image rewriting, raw
  HTML passthrough.
- `sanitize.test.ts` — XSS stripping (`<script>` / `onerror` / `javascript:`),
  the `style` whitelist (BUG-5: stripped on `div/p/pre`, kept on `span`/`code`/
  SVG), Mermaid SVG structure retention, `data-mermaid-slot` retention, and
  KaTeX `<math>` / `<annotation>` retention.

> When you touch `markdownPipeline.ts` or `sanitize.ts`, add/extend a test so
> the behavior stays locked. The single sanitization gate must never be
> bypassed: `sanitizeHtml()` is the only producer of the branded `SanitizedHtml`
> type, and `patchPreviewContent()` is the only DOM write entry that accepts it —
> so an unsanitized string fails to compile rather than fail at runtime.

### Coverage policy

The coverage gate (`npm run test:coverage`, run in the CI `ut` job, which starts in parallel with — not after — the separate `quality` job) enforces **100%** on the
repository's **unit-testable logic surface** (statements / branches / functions / lines all at
100%, with `perFile: true` so every file must hit 100% individually rather than only the project
aggregate). The conventions are:

1. **The threshold is 100%.** Every file in the unit-testable logic surface (see
   `vitest.include` in `vitest.config.ts`) must reach 100%. The DOM / native integration surface
   (React components, the Electron native main process, workers, the CodeMirror editor, …) is held
   out via `coverage.exclude` and validated by other means (E2E, etc.), so it is outside this gate.
2. **If it falls short, add tests first.** When the coverage gate goes red, **extend the test suite
   to cover the branch/statement to 100%** — do not reach for `v8 ignore` to skip logic that is
   genuinely testable.
3. **Delete dead code that is truly unreachable.** If the red comes from a genuinely unreachable
   dead branch / dead code (e.g. an unreachable `else` caused by a constant-true condition),
   **delete the dead code** rather than masking it with an ignore comment.
4. **If it is genuinely untestable _and_ undeletable, add `v8 ignore` with an explanatory comment.**
   Only as a last resort — when a block can neither be reached under unit tests nor be removed for
   good reason (e.g. it depends on a build-mode value like `import.meta.env.DEV`, or sits at a
   process-entry / child-process boundary) — may you skip it with `/* v8 ignore next N */`. The
   comment **must** say why it is unreachable, why it cannot be deleted, and what other means
   validate it (see the style in `src/renderer/src/store/ui.ts`). `v8 ignore` is a last resort, not
   a shortcut.

## Release Process

MarkFlow releases are **automated** via a single `ci.yml` workflow:

1. Pushing to `main` (or dispatching on `main`) triggers `ci.yml`, which
   builds for macOS / Windows / Linux, computes a `vX.Y.Z-<buildtime>.<sha>` tag
   (base version from `package.json` + commit time + short SHA) and, on the release
   stage, pushes that tag and creates a **draft** GitHub Release.
2. A maintainer reviews the draft (download the artifacts, smoke-test) and then
   **publishes or deletes** it. The git tag is left in place either way, so every
   build stays traceable.
3. To **re-release**, dispatch `ci.yml` on `main` — it rebuilds, mints a
   new tag, and opens a fresh draft.

> ⚠️ Because every merge to `main` produces a draft Release, keep `main` green and
> land changes behind reviewed PRs.

## Create-PR Action (local build & preview)

`actions/create-pr/` is a self-contained GitHub Action (shipped in-repo under `actions/create-pr/`
and referenced via `uses: ./actions/create-pr` in `ci.yml`) that idempotently creates/refreshes a PR
from a head branch into `main`. Its full design, plugin mechanism, and local-rendering usage are
documented in [`actions/create-pr/README.md`](actions/create-pr/README.md).

Two root-level scripts wrap it:

```bash
npm run build:action        # ncc bundles src/index.mjs -> dist/index.mjs (built at runtime by auto-pr.yml; dist/ is git-ignored)
npm run local-test-render    # Preview the rendered PR body for a branch (no token, no gh)
```

`npm run local-test-render` runs `actions/create-pr/src/cli-render.mjs` without any GitHub token or
`gh` CLI, so you can verify the rendered body before opening a PR. It resolves `feature/my-branch`
against the default template and prints the result. Optional flags: `--base main`,
`--template .github/pull-request-template.md`, `--blocks-dir .github/create-pr/blocks`, `--no-git`,
`--existing <body.md>` (to preview a refresh of an existing PR).

> ℹ️ **No committed bundle**: `actions/create-pr/dist/index.mjs` is **not** committed (it is
> git-ignored). `auto-pr.yml` rebuilds it from `src/` at workflow runtime, in a step before
> `uses: ./actions/create-pr`, so the action always runs a fresh bundle — there is no stale-bundle
> risk and nothing to commit. Just edit `src/`.

## Building & Packaging

```bash
# Build for current platform (auto-detect)
npm run dist

# Build for specific platforms
npm run dist:mac      # macOS (.dmg)
npm run dist:win      # Windows (.zip, portable — extract and run, no installer)
npm run dist:linux    # Linux (.AppImage)
```

The packaged application is written to `release/`: `release/win-unpacked/` for local runs
and `release/markflow-<version>-win.zip` for distribution.

> **Windows build note**: `npm run dist:win` builds a portable `.zip` with no extra setup — it does
> **not** download or use any code-signing toolset (the old `scripts/prepare-win-codesign.ps1`
> pre-cache script was removed; electron-builder 26 never consumed it). The shipped `MarkFlow.exe`
> is **unsigned** (`win.signExecutable: false`, see ADR-0037), so Windows SmartScreen / "unknown
> publisher" may warn the first time you run it — click **More info → Run anyway**. Icons and version
> info are applied via pure-JS `resedit`, independent of signing. To ship a trusted/signed exe,
> remove `signExecutable: false` and supply a certificate (`win.certificateFile` + `CSC_KEY_PASSWORD`,
> or `win.azureSignOptions` for Azure Trusted Signing).

## Submitting Changes

1. Fork the repository and create your feature branch
   (`git checkout -b feature/amazing-feature`).
2. Make your changes, following the [Coding Conventions](#coding-conventions) above.
3. Commit using conventional commits
   (`git commit -m 'feat: add some amazing feature'`).
4. Push to your fork (`git push origin feature/amazing-feature`).
5. Open a Pull Request against `main`.

## Bug Reports

Please file bugs on the
[GitHub Issues](https://github.com/yourusername/markflow/issues) page. Include:

- Your operating system and version
- MarkFlow version (see `Help > About`)
- Steps to reproduce the bug
- Expected vs actual behavior
- Screenshots (if applicable)

> 🔒 **Security vulnerabilities**: do **not** open a public issue. Use the
> [Security advisory](https://github.com/yourusername/markflow/security/advisories/new)
> form instead (see `SECURITY.md`).

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
