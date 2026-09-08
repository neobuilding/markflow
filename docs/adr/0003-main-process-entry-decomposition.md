# ADR-0003: Main-process entry decomposition

- **Status:** Accepted
- **Implemented:** 2026-08 (behavior-preserving; verified via typecheck + 166 main-process unit cases + e2e)

## Context

Three entry files had grown past their remit:

- `electron/main/index.ts` — ~902 lines mixing app bootstrap (module-level side effects, single-instance
  lock, `whenReady` orchestration) with implementation details and IPC handlers.
- `electron/preload/index.ts` — inlined 8 API mirror groups (~95% of its length) plus `require`/`import`
  mixing.
- `src/renderer/src/i18n/index.ts` — mixed a `localStorage` storage layer and formed a circular dependency
  with `store/ui`.

The goal was to reduce these to composition roots (side effects + orchestration only), moving
implementation into focused, dependency-ordered modules — **without changing runtime behavior.**

## Decision

Decompose, preserving behavior:

- **Main:** split into `lib/csp`, `ipc/appdoc`, `lib/app-paths`, `window`, `menu`, `handlers/*`
  (app/dialog/files/theme/window), `lifecycle`, and **`state`** — a zero-dependency base (`get/setMainWindow`,
  `get/setIsQuiting`, `get/setReadyToQuit`, `pendingInitialPaths`) that breaks the `window ↔ lifecycle ↔
menu` three-way cycle. The entry keeps only module-level side effects and `whenReady` orchestration.
- **Preload:** split by domain into `api/*.ts` (8 groups). Despite the multi-file source, the build still
  emits a single CJS `preload.js` (`vite-plugin-electron` hard-codes `codeSplitting: false`), so the load
  path is unchanged. Source uses ESM `import`; the runtime artifact is CJS.
- **i18n:** split into `storage.ts` + `useT.ts`; `index.ts` re-exports `useT` and no longer imports the UI
  store, removing the circular dependency.
- **Window-focus bug:** the previously attempted `webContents.focus()` IPC was **removed** — it was
  empirically disproven (no-op when the window is already foreground) and is documented as "do not retry"
  in `docs.local/troubleshooting-editor-focus*.md`. The real root cause (native `window.confirm` triggering
  an OS-level `WIN-BLUR`) was fixed with `dialog:confirm` (app-modal `dialog.showMessageBox`).

## Consequences

- **Positive:** smaller, singly-ordered modules; `state.ts` is the explicit dependency-breaker.
- **Positive:** preload remains a single CJS file; i18n is no longer circular.
- **Negative:** module resolution must use relative paths (the `@main/*` tsconfig alias is not configured in
  the vite electron build), or the build fails.
- **Negative:** any future change to the entry must preserve the documented `whenReady` handler ordering and
  module-side-effect placement.
