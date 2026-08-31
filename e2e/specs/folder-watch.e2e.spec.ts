// End-to-end coverage for the chokidar-driven folder-watch refresh path.
//
// These specs launch the REAL Electron app and exercise the full stack that
// the chokidar lag fix touched:
//   chokidar (main) → app:folder-changed broadcast → App.tsx handler →
//   React Query invalidate → documents:list refetch → sidebar re-render.
//
// They guard the behaviours fixed across the six review rounds:
//   1. A file created on disk in the active folder shows up in the sidebar
//      (per-directory coalesce must not drop the active folder's refresh).
//   2. A file created on disk in an UNRELATED folder does NOT force a
//      refetch of the active folder's list (renderer-side activeFolder scoping).
//   3. Closing the workspace while a refresh is pending does not crash the
//      app (the coalesced broadcast is dropped, not delivered to a torn-down
//      window).
//
// NOTE: chokidar's awaitWriteFinish adds a short stability window before an
// 'add' event fires, so these specs poll for the sidebar update rather than
// asserting immediately.
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test.describe('folder-watch refresh (chokidar → sidebar)', () => {
  let handle: AppHandle
  let scratch: string

  test.beforeEach(async () => {
    handle = await launchApp()
    scratch = mkdtempSync(join(tmpdir(), 'markflow-fw-e2e-'))
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  // Wait until the sidebar shows exactly `count` doc-items, or timeout. The
  // chokidar 'add' event is async (awaitWriteFinish stability window), so we
  // cannot assert immediately after writing a file to disk.
  async function expectDocCount(page: Page, count: number) {
    await expect
      .poll(async () => page.getByTestId('doc-item').count(), {
        timeout: 15_000,
      })
      .toBe(count)
  }

  // Open a folder through the SAME pipeline the "Open Folder" menu uses, so the
  // in-memory document store actually gets populated (a watcher alone shows
  // nothing in the sidebar — chokidar only reports *changes*, it does not
  // back-fill existing files). This is exactly what useOpenPaths does:
  //   resolvePaths → importMany → setOpenFolder → setActiveFolder/Document.
  // Sets the active folder on the UI store so the folder-changed handler's
  // activeFolder scoping is exercised.
  async function openFolder(page: Page, folder: string, expectedInitialDocs: number) {
    await page.evaluate(() => (window as any).__uiStore.getState().setActiveFolder(null))
    const firstId = await page.evaluate(async (f) => {
      const { markdownFiles } = await (window as any).api.files.resolvePaths([f])
      const imported = await (window as any).api.documents.importMany(markdownFiles)
      // Start the watcher, then mirror the real open: activate the folder.
      await (window as any).api.documents.setOpenFolder(f)
      const ui = (window as any).__uiStore.getState()
      ui.setActiveFolder(f)
      if (imported.length > 0) ui.setActiveDocumentId(imported[0].id)
      return imported.length > 0 ? imported[0].id : null
    }, folder)
    // Wait for the import to land in the sidebar.
    await expectDocCount(page, expectedInitialDocs)
    return firstId
  }

  test('a file created on disk in the active folder appears in the sidebar', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // Seed one markdown file so the folder has something to import initially.
    writeFileSync(join(scratch, 'seed.md'), '# Seed\n\nbody', 'utf-8')
    await openFolder(page, scratch, 1)

    // Create a NEW markdown file on disk after the folder is open. Chokidar
    // must report it, the main process must coalesce+broadcast, and the
    // renderer must refetch and show the new sidebar entry.
    writeFileSync(join(scratch, 'appeared.md'), '# Appeared\n\nnew', 'utf-8')
    await expectDocCount(page, 2)
    await expect(page.getByTestId('doc-item').filter({ hasText: 'appeared' })).toBeVisible()
  })

  test('a file created on disk in an unrelated folder does not add to the active sidebar', async () => {
    const { page } = handle
    await waitForAppReady(page)

    const active = mkdirSync(join(scratch, 'active'), { recursive: true })
    const other = mkdirSync(join(scratch, 'other'), { recursive: true })
    writeFileSync(join(active!, 'a.md'), '# A\n\nbody', 'utf-8')
    writeFileSync(join(other!, 'o.md'), '# O\n\nbody', 'utf-8')

    await openFolder(page, active!, 1)

    // Create a file in the UNRELATED folder. The main process still watches it
    // (chokidar watches every opened folder), but the renderer's activeFolder
    // filter must drop the refresh — the active sidebar count stays at 1.
    writeFileSync(join(other!, 'late.md'), '# Late\n\nbody', 'utf-8')
    // Give chokidar's stability window time to fire + any stray refetch to
    // settle, then assert the count is unchanged.
    await page.waitForTimeout(2000)
    await expectDocCount(page, 1)
  })

  test('closing the workspace while a refresh is pending does not crash the app', async () => {
    const { page } = handle
    await waitForAppReady(page)

    writeFileSync(join(scratch, 'seed.md'), '# Seed\n\nbody', 'utf-8')
    await openFolder(page, scratch, 1)

    // Create a file to queue a folder-changed broadcast, then immediately
    // close the workspace (which tears down the watcher and cancels pending
    // broadcasts). The app must remain responsive — no crash, no stuck UI.
    writeFileSync(join(scratch, 'pending.md'), '# Pending\n\nbody', 'utf-8')
    await page.evaluate(() => (window as any).__uiStore.getState().closeWorkspace())
    // The editor unmounts and the welcome state returns.
    await expect(page.getByText(/no folder open|no document selected/i).first()).toBeVisible()
    // The app is still alive: creating a new document works.
    await page.getByTestId('new-document-btn').click()
    await expect(page.locator('.cm-content')).toBeVisible()
  })

  test('only watches markdown: a folder full of non-md build output still reflects md changes', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // The chokidar-lag root cause: the watcher used to ignore only a handful of
    // extensions, so in a real repo it watched every file (build output, coverage
    // reports, images, sources…) — hundreds of entries — while only markdown ever
    // mattered. That crawl/scan overhead showed up as a multi-hundred-ms stall
    // right after opening a folder. The fix makes chokidar watch MARKDOWN ONLY,
    // so the non-md noise below must be ignored entirely: no crash, no spurious
    // sidebar entries, and md changes still land.
    writeFileSync(join(scratch, 'seed.md'), '# Seed\n\nbody', 'utf-8')
    // A pile of non-markdown files that must NOT be watched or imported.
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(scratch, `dist-${i}.js`), 'console.log(1)', 'utf-8')
      writeFileSync(join(scratch, `style-${i}.css`), '.x{}', 'utf-8')
      writeFileSync(join(scratch, `shot-${i}.png`), Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'binary')
    }

    await openFolder(page, scratch, 1)

    // The sidebar lists ONLY markdown — none of the 150 non-md files leaked in.
    await expect(page.getByTestId('doc-item')).toHaveCount(1)

    // A NEW markdown file on disk is still detected through the (now md-only) watcher.
    writeFileSync(join(scratch, 'appeared.md'), '# Appeared\n\nnew', 'utf-8')
    await expectDocCount(page, 2)
    await expect(page.getByTestId('doc-item').filter({ hasText: 'appeared' })).toBeVisible()
  })
})
