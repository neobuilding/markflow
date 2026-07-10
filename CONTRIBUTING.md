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

- Node.js >= 18
- npm >= 9
- A C++ toolchain (required to compile the native `better-sqlite3` module during
  `npm install` → `electron-builder install-app-deps`):
  - **Windows**: Install **Visual Studio Build Tools** (2019 or newer) with the
    **“使用 C++ 的桌面开发” (Desktop development with C++)** workload. This installs
    the MSVC toolset + Windows SDK that `node-gyp` needs. Download the VS2022
    installer from <https://aka.ms/vs/17/release/vs_buildtools.exe>, or modify an
    existing install via the Visual Studio Installer.
  - **macOS / Linux**: Xcode Command Line Tools (`xcode-select --install`) /
    `build-essential` + `python3` respectively (the CI `build-check` job already
    covers these on Linux).

> ⚠️ **Windows gotcha**: without the C++ workload, `npm install` fails at the
> `postinstall` step with `gyp ERR! find VS … missing any VC++ toolset`. The fix is
> installing the “Desktop development with C++” workload above — not skipping
> `postinstall` (that would leave `better-sqlite3` with the wrong Electron ABI and
> crash at runtime).

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
│   │   ├── db/           # SQLite database & migrations
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

| Layer | Technology |
|-------|------------|
| Build | Vite 5 + vite-plugin-electron |
| Desktop | Electron 30 |
| Frontend | React 18 + TypeScript (strict) + Tailwind CSS 3.4 |
| UI Components | Radix UI primitives (shadcn/ui style) |
| State | Zustand (UI) + TanStack Query v5 (IPC) |
| Storage | better-sqlite3 + FTS5 + Markdown file dual-write |
| Editor | CodeMirror 6 with Markdown syntax highlighting |
| Math | KaTeX (LaTeX formula rendering) |
| Diagrams | Mermaid.js |
| Packaging | electron-builder |

## Coding Conventions

- **Commits**: follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `docs:`, `chore:`, `BREAKING CHANGE:` / `feat!:` …).
  The CI derives the next **semantic version** from commit messages, so this matters.
- **Type safety**: `npm run typecheck` must pass (no new `any` without reason).
- **Security**: every PR is scanned by **CodeQL** (`codeql.yml`). If it flags something,
  triage it rather than disabling the check.

## Release Process

MarkFlow releases are **automated**:

1. Pushing to `main` triggers `ci.yml`, which computes the next semantic version
   (from conventional commits) and creates a `vX.Y.Z-<buildtime>` tag.
2. That tag push triggers `release.yml`, which builds for macOS / Windows / Linux
   and publishes a GitHub Release.
3. To **re-release an existing tag**, run `release.yml` manually via
   `workflow_dispatch` and supply the tag.

> ⚠️ Because every merge to `main` produces a Release, keep `main` green and
> land changes behind reviewed PRs.

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
> - Run the build again (the script should have pre-cached correctly), or
> - Enable Windows **Developer Mode** (Settings → System → Developer options), or
> - Run your terminal as Administrator.
>
> **winCodeSign 缓存位置**：构建时若看到 `[winCodeSign] Cache already prepared. Skipping.`，说明代码签名工具已缓存。默认缓存目录为：
> ```
> %LOCALAPPDATA%\electron-builder\Cache\winCodeSign
> ```
> 即 `C:\Users\<用户名>\AppData\Local\electron-builder\Cache\winCodeSign`，目录内为形如 `winCodeSign-2.x.x` 的版本文件夹。
>
> 查看或确认缓存目录（cmd）：
> ```cmd
> rem 打印缓存路径
> echo %LOCALAPPDATA%\electron-builder\Cache\winCodeSign
> rem 列出已缓存的版本
> dir "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign"
> ```
>
> 注意：若设置过 `CSC_CACHE` 环境变量，或在 `electron-builder` 配置中指定了自定义的 `cache`/`winCodeSign` 路径，缓存位置会被覆盖。要强制重新下载，删除该目录下对应的版本文件夹即可，下次 `npm run dist:win` 会重新拉取。

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
