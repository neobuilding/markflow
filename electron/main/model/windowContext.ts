// Per-window workspace isolation.
//
// MarkFlow is becoming a multi-window app: each BrowserWindow owns an independent workspace root,
// document store, folder watcher and undo/replace transaction. The pre-P3 code kept all of those
// as module-level singletons, which would make one window's `setWorkspaceRoot` clear another's
// documents (the store is in-memory with no persistence, so that data would be lost permanently).
//
// This module is the single registry. `AsyncLocalStorage` carries the active WindowContext through
// every async call made inside an IPC handler, so existing store/root/watcher helpers can stay
// parameterless: they call currentStore()/currentRoot() which read the ALS scope established once
// at the handler boundary. This avoids threading an explicit `ctx` through ~45 store accesses and
// ~20 root/watcher calls in ipc/documents.ts while keeping per-window isolation correct.
import { AsyncLocalStorage } from 'node:async_hooks'
import type { BrowserWindow, WebContents } from 'electron'
import type { Document } from './documentStore'

export interface WindowContext {
  /** webContents.id of the owning renderer — the stable key used by IPC event.sender. */
  id: number
  win: BrowserWindow
  /** This window's private document map (replaces the old module-level `docs`). */
  docs: Map<string, Document>
  /** This window's workspace root (null before a workspace is opened). */
  workspaceRoot: string | null
  /** Bumped on every root swap so listeners can detect a stale workspace. */
  workspaceSession: number
  /** Per-window force-close safety-net timer handle. */
  closeForceTimer: NodeJS.Timeout | null
  /** Renderer opened the unsaved-changes dialog for this window (disarms its safety net). */
  quitPending: boolean
  /** This window answered its guard; let its `close` event through without re-prompting. */
  closeAllowed: boolean
  /** Paths queued before this window's renderer was ready. */
  pendingPaths: string[]
}

const contexts = new Map<number, WindowContext>()
const als = new AsyncLocalStorage<WindowContext>()
let activeId: number | null = null

// One factory for the full context shape: the headless fallback and a real window used to repeat
// every field, so adding a per-window field meant editing two literals and risked leaving the
// fallback with a different default (which would silently leak state into unrelated unit tests).
function createWindowContext(id: number, win: BrowserWindow): WindowContext {
  return {
    id,
    win,
    docs: new Map(),
    workspaceRoot: null,
    workspaceSession: 0,
    closeForceTimer: null,
    quitPending: false,
    closeAllowed: false,
    pendingPaths: [],
  }
}

// Fallback context for code paths with no window (unit tests, headless startup before the first
// window exists). Production IPC always runs inside withContext(), so only non-window callers land
// here. Keeping it makes the pre-existing parameterless store/root helpers work unchanged in tests.
const fallback: WindowContext = createWindowContext(-1, null as unknown as BrowserWindow)

export function registerWindow(win: BrowserWindow): WindowContext {
  const ctx = createWindowContext(win.webContents.id, win)
  contexts.set(ctx.id, ctx)
  activeId = ctx.id
  return ctx
}

export function unregisterWindow(id: number): void {
  contexts.delete(id)
  if (activeId === id) {
    activeId = contexts.size ? [...contexts.keys()][contexts.size - 1] : null
  }
}

/** Look up by the `event.sender` of an IPC invocation. Falls back to the active window. */
export function contextFor(
  source?: WebContents | { id: number } | null,
): WindowContext | undefined {
  if (source && contexts.has(source.id)) return contexts.get(source.id)
  return activeContext()
}

/**
 * Look up by `event.sender` WITHOUT the active-window fallback.
 *
 * `contextFor` deliberately falls back to the active window, which is what a handler wants when it
 * only needs SOME window's state. The quit handshake must NOT do that: a reply from a renderer
 * whose window was already destroyed (or from an unknown sender) must not be credited to whichever
 * window happens to be active — that would let one window's confirmation close another window.
 */
export function exactContextFor(
  source?: WebContents | { id: number } | null,
): WindowContext | undefined {
  if (!source) return undefined
  return contexts.get(source.id)
}

export function allContexts(): WindowContext[] {
  return [...contexts.values()]
}

export function activeContext(): WindowContext | undefined {
  return activeId === null ? undefined : contexts.get(activeId)
}

/**
 * Run `fn` with `ctx` as the implicit context. IPC handlers wrap their whole body in this so every
 * downstream currentStore()/currentRoot()/watcher call resolves to the right window — including
 * across await boundaries.
 */
export function withContext<T>(ctx: WindowContext | undefined, fn: () => T): T {
  // No registered window (tests, headless startup): use the fallback so all store/root helpers
  // still resolve to a valid, isolated context.
  return als.run(ctx ?? fallback, fn)
}

/** The context for the current async chain, active window, or the headless fallback. */
export function currentContext(): WindowContext {
  return als.getStore() ?? activeContext() ?? fallback
}

export function currentStore(): Map<string, Document> {
  return currentContext().docs
}

/** Test-only: reset the registry between suites (mirrors the existing state.test.ts pattern). */
export function __resetWindowContextsForTests(): void {
  contexts.clear()
  activeId = null
  fallback.docs.clear()
  fallback.workspaceRoot = null
  fallback.workspaceSession = 0
}
