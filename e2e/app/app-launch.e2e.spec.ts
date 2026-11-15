import { test, expect } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'

// One app launch for the whole file. Each scenario keeps its own labelled step so a failure still
// names the exact assertion that broke. The separate "New Document button is visible" case was
// removed: it duplicated the assertion already made here in the boot step.
test.describe('MarkFlow app launch', () => {
  let handle: AppHandle
  test.beforeAll(async () => {
    handle = await launchApp()
  })
  test.afterAll(async () => {
    await closeApp(handle)
  })

  test('boots, renders, and exposes the preload bridge', async () => {
    const { page } = handle
    await waitForAppReady(page)

    await test.step('renderer mounted with no editor open', async () => {
      // Window title should be the product name.
      expect(await page.title()).toBe('MarkFlow')

      // In the no-document state the Markdown editor is NOT mounted.
      await expect(page.locator('.cm-content')).toHaveCount(0)
      // The sidebar (with the New Document button) is visible.
      await expect(page.getByTestId('new-document-btn')).toBeVisible()
    })

    await test.step('contextBridge exposed window.api to the renderer', async () => {
      // The preload contextBridge must have exposed window.api with the
      // document IPC surface the renderer depends on.
      const hasApi = await page.evaluate(() => {
        return (
          typeof window.api === 'object' &&
          typeof window.api.documents?.create === 'function' &&
          typeof window.api.documents?.list === 'function'
        )
      })
      expect(hasApi).toBe(true)
    })
  })
})
