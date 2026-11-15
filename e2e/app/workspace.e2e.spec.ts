import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'

// One app launch for the file. Each scenario keeps its own labelled step; `resetWorkspace`
// deletes every document left by the previous step so the assertions stay independent.
test.describe('workspace lifecycle (close / delete)', () => {
  let handle: AppHandle
  test.beforeAll(async () => {
    handle = await launchApp()
  })
  test.afterAll(async () => {
    await closeApp(handle)
  })

  // Create a new in-app draft via the real sidebar "+" button.
  async function createViaButton(page: Page) {
    await page.getByTestId('new-document-btn').click()
    await expect(page.locator('.cm-content')).toBeVisible()
  }

  // A single app instance is shared by the steps, so clear the document store between them.
  async function resetWorkspace(page: Page) {
    await page.evaluate(async () => {
      const w = window as any
      const docs = await w.api.documents.list()
      for (const d of docs) await w.api.documents.delete(d.id)
      w.__uiStore.getState().closeDocument()
      w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
    })
    await expect(page.getByTestId('doc-item')).toHaveCount(0)
  }

  test('close, delete, and re-create a document', async () => {
    const { page } = handle
    await waitForAppReady(page)

    await test.step('closing the current document returns to the no-document welcome state', async () => {
      await resetWorkspace(page)
      await createViaButton(page)
      await expect(page.locator('.cm-content')).toBeVisible()

      // Close via the REAL UI store (the same call the Close File menu item makes).
      await page.evaluate(() => (window as any).__uiStore.getState().closeDocument())

      // Welcome state is shown again and the editor is unmounted.
      await expect(page.locator('.cm-content')).toHaveCount(0)
      // Either the editor's empty-state ("No document selected") or the sidebar's
      // welcome state ("No folder open") confirms we are back to a clean workspace.
      await expect(page.getByText(/no document selected|no folder open/i).first()).toBeVisible()
    })

    await test.step('deleting a draft removes it from the sidebar document list', async () => {
      await resetWorkspace(page)
      await createViaButton(page)

      // Capture the active document id, delete it via the real IPC, then refresh
      // the document list cache (mirroring what the sidebar's delete path does).
      const id = await page.evaluate(() => {
        const w = window as any
        const cur = w.__uiStore.getState().activeDocumentId
        return w.api.documents.delete(cur).then(() => {
          w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
          return cur
        })
      })

      expect(id).toBeTruthy()
      // The draft is gone -> no document item remains in the sidebar.
      await expect(page.getByTestId('doc-item')).toHaveCount(0)
      await expect(page.getByText(/no document selected|no folder open/i)).toBeVisible()
    })

    await test.step('the new-document button restores an editor after closing the workspace', async () => {
      await resetWorkspace(page)

      // Open, then close the document, then create again -> the editor comes back.
      await createViaButton(page)
      await page.evaluate(() => (window as any).__uiStore.getState().closeDocument())
      await expect(page.locator('.cm-content')).toHaveCount(0)

      await createViaButton(page)
      await expect(page.locator('.cm-content')).toBeVisible()
    })
  })
})
