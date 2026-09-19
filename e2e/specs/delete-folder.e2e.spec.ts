// Reproduction for "deleting a folder inside the open workspace still asks for admin
// permission" (Windows EPERM when shell.trashItem cannot move a directory that some
// process holds open). Drives the REAL app: open a folder, delete one of its subfolders
// through the sidebar context menu, and assert the folder actually leaves the disk.
//
// If the delete is blocked (the bug), the folder stays on disk and the poll times out
// (red). If the fix is effective, the folder disappears (green).
import { test, expect, type Page } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { launchApp, waitForAppReady, closeApp, type AppHandle } from '../helpers/launch'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir } from '../helpers/temp'

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

test.describe('delete watched folder (admin-permission regression)', () => {
  let handle: AppHandle

  test.beforeEach(async () => {
    handle = await launchApp()
  })
  test.afterEach(async () => {
    await closeApp(handle)
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

  test('deleting a subfolder of the open workspace removes it from disk (no admin prompt)', async () => {
    const { page, electronApp } = handle
    await waitForAppReady(page)
    // Accept any alert (e.g. the "delete failed" message) so it does not block the test.
    const dialogs: string[] = []
    page.on('dialog', async (d) => {
      dialogs.push(d.message())
      await d.accept()
    })

    const dir = mkTempDir('markflow-delfolder-')
    mkdirSync(join(dir, 'aa'), { recursive: true })
    writeFileSync(join(dir, 'aa', 'note.md'), '# hi\n')
    writeFileSync(join(dir, 'root.md'), '# root\n')
    await openFolder(page, dir, 2)

    const sub = page.getByTestId('folder-row').filter({ hasText: 'aa' })
    await expect(sub).toBeVisible()
    await sub.click({ button: 'right' })
    await expect(page.getByTestId('side-delete-folder')).toBeVisible()
    await installConfirmSpy(electronApp, 1) // confirm = OK
    await page.getByTestId('side-delete-folder').click()

    // The folder must actually leave the disk. If it is blocked (the bug), it stays.
    await expect
      .poll(() => existsSync(join(dir, 'aa')), {
        timeout: 15000,
        message: `folder 'aa' should have been removed; alerts seen: ${dialogs.join(' | ')}`,
      })
      .toBe(false)

    // The sidebar must also stop showing the deleted folder. The document records inside
    // it are removed from the store and the parent is told to refresh, so the folder row
    // must disappear (regression: it used to stay visible after a successful delete).
    await expect(page.getByTestId('folder-row').filter({ hasText: 'aa' })).toHaveCount(0, {
      timeout: 15000,
    })
  })
})
