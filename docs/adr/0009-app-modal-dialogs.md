# ADR-0009: App-modal dialogs over native window.confirm

- **Status:** Accepted
- **Implemented:** 2026-08-07 (`PLAN-improvements-2026-08-done.md` §8.1)

## Context

Native `window.confirm` is an OS-modal blocking dialog. On Windows, Electron treats it as a window
**blur** (WIN-BLUR); after the dialog closes, focus is **not** returned to the renderer, so
`document.hasFocus()` sticks at `false` and CodeMirror stops receiving keyboard events — the editor
becomes untypeable after switching/discarding a dirty document until an Alt-Tab away and back. Six
call sites used `window.confirm` for the unsaved-changes prompt.

## Decision

Replace every unsaved-change `window.confirm` with a `dialog:confirm` IPC backed by
`dialog.showMessageBox` (an **app-modal** dialog). `showMessageBox` returns focus to the main window on
close, so no WIN-BLUR residual remains.

- `tryCloseWorkspace()` keeps its **synchronous `boolean`** contract: on a dirty doc it fire-and-forgets
  `dialog.confirm` and only closes inside the confirm callback; the function itself still returns `false`
  synchronously.
- The BrowserWindow is created with `sandbox: false` so focus reliably returns on macOS too. MarkFlow is a
  local-first desktop app that loads no remote web content, so disabling the sandbox is an acceptable,
  documented risk.

## Consequences

- **Positive:** focus preserved; one consistent unsaved-change prompt across close-file / close-workspace
  / switch-doc / drop.
- **Negative:** a main-process IPC handler + preload entry + i18n strings (`app.confirmDiscard` /
  `app.confirmKeep`); the renderer `sandbox` is disabled (recorded in the security review). Native
  `window.confirm` must never be reintroduced for these prompts.
