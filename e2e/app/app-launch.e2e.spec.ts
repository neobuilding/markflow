import { test, expect } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'

test.describe('MarkFlow app launch', () => {
  let handle: AppHandle
  test.beforeEach(async () => {
    handle = await launchApp()
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  test('boots and renders the renderer with no editor open', async () => {
    const { page } = handle

    // The React app must have mounted content into #root.
    await waitForAppReady(page)

    // Window title should be the product name.
    expect(await page.title()).toBe('MarkFlow')

    // In the no-document state the Markdown editor is NOT mounted.
    await expect(page.locator('.cm-content')).toHaveCount(0)
    // The sidebar (with the New Document button) is visible.
    await expect(page.getByTestId('new-document-btn')).toBeVisible()
  })

  test('exposes the preload bridge (window.api) to the renderer', async () => {
    const { page } = handle
    await waitForAppReady(page)

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

  test('shows the sidebar with a New Document button', async () => {
    const { page } = handle
    await waitForAppReady(page)

    await expect(page.getByTestId('new-document-btn')).toBeVisible()
  })
})
