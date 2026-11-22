// IPC handler wrapper that establishes the per-window AsyncLocalStorage scope.
//
// Every ipcMain listener receives an event whose `sender` is the requesting renderer. Wrapping
// listeners here means the parameterless documentStore/workspaceRoot/folderWatcher helpers resolve
// to THAT window's state for the whole async chain, without threading an explicit ctx through
// ~45 store accesses and ~20 root/watcher calls in ipc/documents.ts.
import type { IpcMainInvokeEvent } from 'electron'
import { contextFor, withContext } from './windowContext'

// `any[]` mirrors Electron's own variadic `ipcMain.handle/on` signatures: the concrete listener
// argument tuple is decided by each call site, and a bus fake must stay assignable to Electron's
// bus. The wrapper below re-types every listener to (SenderEvent, ...Args), so the rest of the
// scope plumbing stays generic and type-safe.
type IpcBus = {
  handle: (channel: string, listener: (...args: any[]) => any) => void
  on: (channel: string, listener: (...args: any[]) => void) => void
}
// Type-only import: erased at runtime, so electron mocks that omit ipcMain stay valid. Handlers need
// the full WebContents API (isDestroyed/send), not just `id`, while tests may call them with a null
// event — hence the `| null`.
type SenderEvent = IpcMainInvokeEvent | null

function wrap<Args extends unknown[], R>(
  listener: (event: SenderEvent, ...args: Args) => R | Promise<R>,
): (event: SenderEvent, ...args: Args) => R | Promise<R> {
  return (event, ...args) => {
    // Tests invoke handlers with a null event; fall back to the headless context.
    const sender = event?.sender ?? null
    return withContext(contextFor(sender), () => listener(event, ...args))
  }
}

/**
 * Register a scoped `handle` listener on an explicit bus. Callers pass their own `ipcMain` so this
 * module never imports 'electron' itself (several tests mock 'electron' without ipcMain, and
 * modules with an injected bus rely on that).
 */
export function scopedHandleFor(
  bus: IpcBus,
  channel: string,
  listener: (event: SenderEvent, ...args: any[]) => unknown,
): void {
  bus.handle(channel, wrap(listener))
}

/** Register a scoped `on` listener on an explicit bus. */
export function scopedOnFor(
  bus: IpcBus,
  channel: string,
  listener: (event: SenderEvent, ...args: any[]) => void,
): void {
  bus.on(channel, wrap(listener))
}

/** Explicitly run a non-IPC callback in a window's scope (watcher events, startup paths). */
export function runInContext<T>(ctx: Parameters<typeof withContext>[0], fn: () => T): T {
  return withContext(ctx, fn)
}
