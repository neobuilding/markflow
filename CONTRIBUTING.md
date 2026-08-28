# Contributing to MarkFlow

Thanks for your interest in improving MarkFlow! This guide covers how to set up a
development environment, the conventions we follow, and how changes get released.

> 📖 For **product overview, features, and download instructions**, see the
> [README](README.md). This document is for **contributors**, not end users.

## Code of Conduct

By participating, you agree to uphold a respectful, harassment-free environment.
(Add a `CODE_OF_CONDUCT.md` if your organization requires one.)

## Development Setup

### Prerequisites

- Node.js >= 22
- npm >= 9

> 💡 No native toolchain is required: MarkFlow uses an in-memory document store and a
> pure-JS search index (minisearch), so `npm install`
> works without a C++ compiler.

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

| Layer             | Technology                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| Build             | Vite 8 + vite-plugin-electron                                                                          |
| Desktop           | Electron 43                                                                                            |
| Frontend          | React 19 + TypeScript (strict) + Tailwind CSS 4                                                        |
| UI Components     | Radix UI primitives (shadcn/ui style)                                                                  |
| State             | Zustand (UI) + TanStack Query v5 (IPC)                                                                 |
| Storage           | In-memory document store (Map) + minisearch index + chokidar folder watcher + Markdown file dual-write |
| Editor            | CodeMirror 6 with Markdown syntax highlighting                                                         |
| Math              | KaTeX (LaTeX formula rendering)                                                                        |
| Diagrams          | Mermaid.js                                                                                             |
| Markdown parser   | markdown-it + plugins (GFM, KaTeX, GitHub Alerts, containers)                                          |
| HTML sanitization | DOMPurify + `SafeHtml` forced gate (single XSS point)                                                  |
| Testing           | Vitest + jsdom                                                                                         |
| Packaging         | electron-builder                                                                                       |

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
> the behavior stays locked. The single sanitization gate (`SafeHtml` →
> `sanitizeHtml`) must never be bypassed.

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
npm run build:action        # ncc bundles actions/create-pr/src/index.mjs -> dist/index.mjs
npm run local-test-render    # Preview the rendered PR body for a branch (no token, no gh)
```

`npm run local-test-render` runs `actions/create-pr/src/cli-render.mjs` without any GitHub token or
`gh` CLI, so you can verify the rendered body before opening a PR. It resolves `feature/my-branch`
against the default template and prints the result. Optional flags: `--base main`,
`--template .github/pull-request-template.md`, `--blocks-dir .github/create-pr/blocks`, `--no-git`,
`--existing <body.md>` (to preview a refresh of an existing PR).

> ⚠️ **Rebuild the bundle after editing the Action**: the bundled
> `actions/create-pr/dist/index.mjs` is committed on purpose (GitHub requires it for a direct
> `uses:` reference). Any change under `actions/create-pr/src/` must be followed by
> `npm run build:action`, and the rebuilt `dist/index.mjs` committed alongside the source change —
> otherwise CI ships a stale bundle. Treat `dist/` as a build artifact that must track `src/`.

## Building & Packaging

```bash
# Build for current platform (auto-detect)
npm run dist

# Build for specific platforms
npm run dist:mac      # macOS (.dmg)
npm run dist:win      # Windows (unpacked dir, no installer needed)
npm run dist:linux    # Linux (.AppImage, .deb, .rpm)
```

The packaged application will be in the `release/win-unpacked/` directory. Zip this
folder for distribution — users just extract and run `MarkFlow.exe`, no installation required.

> **Windows build note**: `npm run dist:win` automatically runs a pre-build script
> (`scripts/prepare-win-codesign.ps1`) that downloads and extracts only the Windows
> code-signing tools, skipping macOS symbolic links that fail on non-administrator
> Windows accounts. No manual setup needed — just run `npm run dist:win` and it works.
>
> If you encounter the error `Cannot create symbolic link`, either:
>
> - Run the build again (the script should have pre-cached correctly), or
> - Enable Windows **Developer Mode** (Settings → System → Developer options), or
> - Run your terminal as Administrator.
>
> **winCodeSign cache location**: if you see `[winCodeSign] Cache already prepared. Skipping.`
> during a build, the code-signing tools are already cached. The default cache directory is:
>
> ```
> %LOCALAPPDATA%\electron-builder\Cache\winCodeSign
> ```
>
> i.e. `C:\Users\<username>\AppData\Local\electron-builder\Cache\winCodeSign`, which
> contains version folders named like `winCodeSign-2.x.x`.
>
> To inspect or confirm the cache directory (cmd):
>
> ```cmd
> rem print the cache path
> echo %LOCALAPPDATA%\electron-builder\Cache\winCodeSign
> rem list cached versions
> dir "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign"
> ```
>
> Note: if you have set the `CSC_CACHE` environment variable, or specified a custom
> `cache`/`winCodeSign` path in the `electron-builder` config, the cache location is
> overridden. To force a re-download, delete the corresponding version folder under
> that directory; the next `npm run dist:win` will fetch it again.

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
