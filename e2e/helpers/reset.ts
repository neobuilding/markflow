// Shared state reset for specs that deliberately reuse ONE Electron instance across several
// `test()` cases (serial mode). Launching Electron is by far the most expensive part of an e2e
// case; reuse cuts that cost without turning the file into a single mega-test — each case keeps
// its own name and failure output.
//
// A reset has to cover BOTH processes: `page.reload()` only rebuilds the renderer (store flags,
// panels, modals, view mode), while the document store, the workspace root, the viewport and the
// main-process confirm-dialog recorder all survive a reload. Without the explicit steps below,
// a draft left by one case collides with the next case's `file_path` — the exact isolation
// guarantee `launch.ts` documents for the per-test user-data-dir approach.
import { VIEWPORTS } from './viewports'
import { waitForAppReady, type AppHandle } from './launch'

export async function resetAppState(handle: AppHandle): Promise<void> {
  const { page, electronApp } = handle
  await page.setViewportSize(VIEWPORTS.standard)
  await page.evaluate(async () => {
    const docs = await window.api.documents.list()
    for (const d of docs) await window.api.documents.delete(d.id)
    await window.api.documents.setWorkspaceRoot(null)
  })
  // `installConfirmSpy` replaces `dialog.showMessageBox` in the MAIN process and appends to
  // `globalThis.__mf_confirm_calls` / `__confirmCalls` without ever clearing them. A page reload
  // does NOT undo a main-process monkey patch, so with a shared instance BOTH problems leak into
  // the next case: the recorders would make `.poll(calls.length).toBeGreaterThan(0)` pass
  // vacuously, and a previous case's auto-answer (0 = keep / 1 = discard) would silently decide
  // the next case's dialog. Restore the native dialog and clear both recorders; each case that
  // needs a confirm installs its own spy again.
  await electronApp.evaluate((electron) => {
    const g = globalThis as unknown as {
      __mf_confirm_calls?: unknown[]
      __confirmCalls?: unknown[]
      __nativeShowMessageBox?: unknown
      __confirmResponse?: number
    }
    const dialog = (electron as { dialog: { showMessageBox: unknown } }).dialog
    if (g.__nativeShowMessageBox) {
      dialog.showMessageBox = g.__nativeShowMessageBox
    } else {
      g.__nativeShowMessageBox = dialog.showMessageBox
    }
    g.__mf_confirm_calls = []
    g.__confirmCalls = []
    delete g.__confirmResponse
  })
  await page.reload()
  await waitForAppReady(page)
}
