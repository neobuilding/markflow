# MarkFlow

<p align="center">
  <img src="resources/icon.png" alt="MarkFlow Logo" width="128" height="128">
</p>

<p align="center">
  <a href="https://github.com/yourusername/markflow/releases"><img src="https://img.shields.io/github/v/release/yourusername/markflow?include_prereleases&style=flat-square" alt="GitHub release"></a>
  <a href="https://github.com/yourusername/markflow/actions"><img src="https://img.shields.io/github/actions/workflow/status/yourusername/markflow/ci.yml?style=flat-square" alt="CI Status"></a>
  <a href="https://github.com/yourusername/markflow/blob/main/LICENSE"><img src="https://img.shields.io/github/license/yourusername/markflow?style=flat-square" alt="License"></a>
</p>

A cross-platform Markdown editor with **Linear-style UI**, built with Electron + React 18 + TypeScript.

## ✨ Features

- **Linear-inspired UI** — Clean, minimal, keyboard-first design
- **Split-pane editing** — Editor + live preview side by side, with draggable divider
- **Folder-aware sidebar** — Open a single file and the whole containing folder loads automatically; open a folder to browse all its Markdown files
- **Read-only by default** — Files open in read-only mode to prevent accidental edits; toggle to Edit mode anytime
- **Close workspace** — One-click close of the current file and folder, returning to an empty state
- **Open anywhere** — Launch via command line, drag-and-drop a file/folder onto the window, or set MarkFlow as the default app for `.md` files
- **Empty on launch** — No previous file/folder is restored; the app always starts fresh
- **Full-text search** — SQLite FTS5 powered, instant results with highlighted snippets
- **Manual save** — No auto-save: use **Save** (⌘/Ctrl+S), **Save As…** (⌘/Ctrl+⇧+S), and **Reload from Disk** (⌘/Ctrl+⇧+R) from the toolbar or File menu
- **Starred documents** — Bookmark important notes for quick access
- **KaTeX math formulas** — Support for inline `$...$` and block `$$...$$` LaTeX formulas
- **Mermaid diagrams** — Render flowcharts, sequence diagrams, and more from ` ```mermaid ` code blocks
- **Dark/Light theme** — Automatic system theme detection with manual toggle
- **Window size memory** — Remembers window position and size across sessions

## 📸 Screenshots

> *Add screenshots here: editor view, split view, dark mode, search palette...*

## 🚀 Quick Start

### Prerequisites

- Node.js >= 18
- npm >= 9

### Development

```bash
# Clone the repository
git clone https://github.com/yourusername/markflow.git
cd markflow

# Install dependencies
npm install

# Start development (Vite dev server + Electron)
npm run dev
```

### Build & Package

```bash
# Build for current platform (auto-detect)
npm run dist

# Build for specific platforms
npm run dist:mac      # macOS (.dmg)
npm run dist:win      # Windows (unpacked dir, no installer needed)
npm run dist:linux    # Linux (.AppImage, .deb, .rpm)
```

The packaged application will be in the `release/win-unpacked/` directory. Zip this folder for distribution — users just extract and run `MarkFlow.exe`, no installation required.

> **Windows build note**: `npm run dist:win` automatically runs a pre-build script (`scripts/prepare-win-codesign.ps1`) that downloads and extracts only the Windows code-signing tools, skipping macOS symbolic links that fail on non-administrator Windows accounts. No manual setup needed — just run `npm run dist:win` and it works.
>
> If you encounter the error `Cannot create symbolic link`, either:
> - Run the build again (the script should have pre-cached correctly), or
> - Enable Windows **Developer Mode** (Settings → System → Developer options), or
> - Run your terminal as Administrator.

### Download Pre-built Binaries

Visit the [Releases](https://github.com/yourusername/markflow/releases) page to download pre-built binaries for macOS, Windows, and Linux.

## 📁 Project Structure

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

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd + N` | New document |
| `Ctrl/Cmd + K` | Search documents |
| `Ctrl/Cmd + \` | Toggle sidebar |
| `Ctrl/Cmd + Shift + P` | Toggle preview mode (edit/preview/split) |
| `Ctrl/Cmd + W` | Close workspace (close current file & folder) |
| `Ctrl/Cmd + O` | Open external `.md` file |
| `Ctrl/Cmd + Shift + O` | Open folder (batch import `.md` files) |
| `Ctrl/Cmd + S` | Save (manual; no auto-save) |
| `Ctrl/Cmd + Shift + S` | Save As… |
| `Ctrl/Cmd + Shift + R` | Reload from Disk (load latest file content) |

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
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

## 📦 Packaging Configuration

The project uses `electron-builder` for cross-platform packaging:

- **macOS**: `.dmg` (x64 + arm64 universal)
- **Windows**: Unpacked directory (x64, green software — extract and run, no installer)
- **Linux**: `.AppImage`, `.deb`, `.rpm`

Configuration is in `electron-builder.json5`. Key settings:

- `appId`: `com.markflow.app`
- `productName`: `MarkFlow`
- `asar`: enabled (with `better-sqlite3` unpacked for native module loading)
- `entitlements`: `resources/entitlements.mac.plist` (macOS sandbox permissions)

## 🤝 Contributing

Contributions are welcome! Please read the [Contributing Guide](CONTRIBUTING.md) and [Code of Conduct](CODE_OF_CONDUCT.md) before getting started.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 🐛 Bug Reports

Please use the [GitHub Issues](https://github.com/yourusername/markflow/issues) page to report bugs. Include:

- Your operating system and version
- MarkFlow version (see `Help > About`)
- Steps to reproduce the bug
- Expected vs actual behavior
- Screenshots (if applicable)

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Electron](https://electronjs.org/) - Cross-platform desktop apps with web technologies
- [React](https://react.dev/) - UI library
- [CodeMirror](https://codemirror.net/) - In-browser code editor
- [KaTeX](https://katex.org/) - Fast math typesetting
- [Mermaid](https://mermaid.js.org/) - JavaScript diagramming and charting
- [Radix UI](https://www.radix-ui.com/) - Unstyled, accessible UI primitives
- [Linear](https://linear.app/) - UI design inspiration

---

<p align="center">
  Built with ❤️ by the MarkFlow Team
</p>
