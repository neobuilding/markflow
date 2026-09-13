// Regression guard for the Vite dev-server watch WHITELIST (vite.config.ts). The
// temp workspace is created INSIDE the repo root on purpose: if Vite's server.watch
// ever regressed from a whitelist back to watching everything under the repo root,
// its chokidar would hold a directory handle on the target folder and block
// shell.trashItem's recycle rename on Windows (the "needs admin permission" prompt).
// The whitelist must keep data/scratch directories out of the watch, so Vite never
// holds that handle and the delete succeeds. The app's OWN watcher is released by
// pauseFolderWatching() during the move; this test proves the dev server's watcher
// is not the one blocking the delete.
import { test, expect, type Page } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { launchApp, waitForAppReady, closeApp, type AppHandle } from '../helpers/launch'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Repo root = two levels up from this file (e2e/specs/).
const __here = fileURLToPath(import.meta.url)
const repoRoot = join(__here, '..', '..')

async function installConfirmSpy(
  electronApp: ElectronApplication,
  response: number,
): Promise<void> {
  await (
    electronApp.evaluate as unknown as (
      fn: (electronMod: { dialog: { showMessageBox: unknown } }, resp: number) => void,
      arg: number,
    ) => Promise<void>
  )((electronMod, resp) => {
    const dialog = electronMod.dialog
    const g = globalThis as unknown as { __confirmCalls?: unknown[]; __confirmResponse?: number }
    g.__confirmCalls = []
    g.__confirmResponse = resp
    dialog.showMessageBox = async (opts: { message?: string }) => {
      g.__confirmCalls!.push(opts)
      return { response: g.__confirmResponse!, checkboxChecked: false }
    }
  }, response)
}

test.describe('delete watched folder under Vite dev watcher', () => {
  let handle: AppHandle
  let scratchRoot: string

  test.beforeEach(async () => {
    handle = await launchApp()
    // Temp workspace INSIDE the repo root so Vite (npm run dev) watches it.
    scratchRoot = mkdtempSync(join(repoRoot, '_e2e-devdel-'))
  })
  test.afterEach(async () => {
    await closeApp(handle)
    // Best-effort cleanup regardless of outcome.
    rmSync(scratchRoot, { recursive: true, force: true })
  })

  async function openFolder(page: Page, folder: string, expectedDocs: number): Promise<void> {
    await page.evaluate(() => (window as any).__uiStore.getState().setActiveFolder(null))
    await page.evaluate(async (f: string) => {
      const { markdownFiles } = await (window as any).api.files.resolvePaths([f])
      const imported = await (window as any).api.documents.importMany(markdownFiles)
      await (window as any).api.documents.setOpenFolder(f)
      const ui = (window as any).__uiStore.getState()
      ui.setActiveFolder(f)
      if (imported.length > 0) ui.setActiveDocumentId(imported[0].id)
    }, folder)
    if (expectedDocs > 0) {
      await expect(page.getByTestId('doc-item').first()).toBeVisible()
    }
  }

  test('deleting a subfolder under the dev-server (Vite) watch root removes it (no admin prompt)', async () => {
    const { page, electronApp } = handle
    await waitForAppReady(page)
    const dialogs: string[] = []
    page.on('dialog', async (d) => {
      dialogs.push(d.message())
      await d.accept()
    })

    const aa = join(scratchRoot, 'aa')
    mkdirSync(aa, { recursive: true })
    writeFileSync(join(aa, 'note.md'), '# hi\n')
    writeFileSync(join(scratchRoot, 'root.md'), '# root\n')
    await openFolder(page, scratchRoot, 2)

    // Sanity: the scratch folder truly lives under the repo root (i.e. inside Vite's
    // server.watch root), so Vite's chokidar is holding a directory handle on `aa`.
    const insideRepo = scratchRoot.startsWith(repoRoot + sep) || scratchRoot.startsWith(repoRoot)
    expect(insideRepo).toBe(true)

    const sub = page.getByTestId('folder-row').filter({ hasText: 'aa' })
    await expect(sub).toBeVisible()
    await sub.click({ button: 'right' })
    await expect(page.getByTestId('side-delete-folder')).toBeVisible()
    await installConfirmSpy(electronApp, 1)
    await page.getByTestId('side-delete-folder').click()

    // Regression: the folder must leave the disk cleanly. Previously this failed
    // because Vite's chokidar watcher (server.watch on the repo root) held a
    // directory handle on `aa`, which blocked shell.trashItem's recycle rename
    // and surfaced the Windows "needs admin permission" elevation prompt.
    await expect
      .poll(() => existsSync(aa), {
        timeout: 15000,
        message: `folder 'aa' should have been removed; alerts seen: ${dialogs.join(' | ')}`,
      })
      .toBe(false)
  })
})
