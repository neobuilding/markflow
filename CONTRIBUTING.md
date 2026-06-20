# Contributing to MarkFlow

Thank you for your interest in contributing to MarkFlow! This document provides guidelines and instructions for contributing.

## Code of Conduct

Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## How Can I Contribute?

### Reporting Bugs

- Use the [GitHub Issues](https://github.com/yourusername/markflow/issues) page
- Check if the bug has already been reported
- Include: OS version, MarkFlow version, steps to reproduce, expected vs actual behavior

### Suggesting Enhancements

- Use the [GitHub Issues](https://github.com/yourusername/markflow/issues) page
- Describe the feature and why it would be useful
- Include mockups or examples if applicable

### Pull Requests

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Development Setup

### Prerequisites

- Node.js >= 18
- npm >= 9
- Git

### Local Development

```bash
# Clone your fork
git clone https://github.com/yourusername/markflow.git
cd markflow

# Install dependencies
npm install

# Start development (Vite dev server + Electron)
npm run dev
```

### Project Structure

```
electron/
  main/          # Electron main process (Node.js)
  preload/       # Preload script (contextBridge)
src/renderer/   # React renderer process
  src/
    components/   # UI components
    hooks/        # TanStack Query hooks
    store/        # Zustand stores
    lib/          # Utilities
    types/        # TypeScript types
```

### Key Technologies

- **Electron 30** — Desktop shell
- **React 18 + TypeScript** — UI
- **Vite 5** — Build tool
- **Tailwind CSS 3.4** — Styling
- **Radix UI** — Accessible UI primitives
- **Zustand** — UI state management
- **TanStack Query v5** — IPC state management
- **better-sqlite3 + FTS5** — Data storage
- **CodeMirror 6** — Markdown editor
- **KaTeX** — Math formula rendering
- **Mermaid.js** — Diagram rendering

## Coding Guidelines

### TypeScript

- Use TypeScript strict mode
- Define prop types for all components
- Avoid `any` type

### React

- Use functional components with hooks
- Keep components small and focused
- Use `React.memo` for performance-critical components

### Styling

- Use Tailwind CSS utility classes
- Use `cn()` utility for conditional classes
- Follow Linear-style design (clean, minimal, keyboard-first)

### State Management

- **Zustand** — UI state (sidebar open/closed, theme, view mode, etc.)
- **TanStack Query** — Server state (IPC calls to main process)

### IPC Communication

- Always use `window.api` (contextBridge) for renderer-to-main communication
- Never use `ipcRenderer` directly in renderer process
- Define all IPC methods in `electron/preload/index.ts`

## Testing

```bash
# Run tests (when available)
npm test

# Run linting
npm run lint

# Run type checking
npm run type-check
```

## Building & Packaging

```bash
# Build for current platform
npm run dist

# Build for specific platforms
npm run dist:mac
npm run dist:win
npm run dist:linux
```

## Commit Messages

Follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
feat: add dark mode toggle
fix: correct KaTeX rendering for matrices
docs: update README with packaging instructions
refactor: simplify IPC handler logic
test: add unit tests for document hooks
```

## Release Process

1. Update version in `package.json`
2. Update `CHANGELOG.md`
3. Create a [GitHub Release](https://github.com/yourusername/markflow/releases/new)
4. GitHub Actions will automatically build and attach binaries

## Questions?

Feel free to open an issue with the `question` label.

---

Thank you for contributing to MarkFlow! 🚀
