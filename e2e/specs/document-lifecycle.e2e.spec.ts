import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'

test.describe('document lifecycle', () => {
  let handle: AppHandle
  test.beforeEach(async () => {
    handle = await launchApp()
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  // Create a document through the REAL sidebar "+" button (handleCreate), which
  // calls useCreateDocument -> invalidates the React Query cache and activates
  // the new draft, exactly like a real user click. The editor opens in edit mode.
  async function createViaButton(page: Page) {
    await page.getByTestId('new-document-btn').click()
    await expect(page.locator('.cm-content')).toBeVisible()
  }

  test('creating a document shows it in the editor and supports view modes', async () => {
    const { page } = handle
    await waitForAppReady(page)

    await createViaButton(page)
    await expect(page.locator('.cm-content')).toBeVisible()

    // Split is the default: both editor and preview are present.
    await expect(page.locator('.cm-editor')).toHaveCount(1)

    // Switch to preview-only: the CodeMirror editor must unmount.
    await page.getByTestId('view-preview').click()
    await expect(page.locator('.cm-editor')).toHaveCount(0)
    await expect(page.locator('h1')).toContainText('Untitled')

    // Switch back to edit-only: the editor returns.
    await page.getByTestId('view-edit').click()
    await expect(page.locator('.cm-editor')).toHaveCount(1)
  })

  test('read-only / edit toggle drives the editor contenteditable state', async () => {
    const { page } = handle
    await waitForAppReady(page)

    await createViaButton(page)

    // The editor mounts with the newly-created document active. The toggle
    // button (data-testid) is always present; we drive it through real clicks
    // and verify the contenteditable attribute on the editor content reflects
    // the resulting mode.
    const toggle = page.getByTestId('toggle-editable-btn')

    // Initial state after creating a draft: editable. The button is reachable.
    await expect(toggle).toBeVisible()

    // Click once -> editable flips.
    await toggle.click()
    await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false')

    // Click again -> back to editable.
    await toggle.click()
    await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true')
  })

  test('switching documents resets edit mode back to read-only', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // Create two documents (the second becomes active + editable).
    await createViaButton(page)
    await createViaButton(page)

    // handleCreate opens the new draft in edit mode.
    await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true')

    // Click the FIRST sidebar item to switch away from the active doc.
    const items = page.getByTestId('doc-item')
    await items.first().click()

    // Switching documents must drop back to read-only (the classic bug guard).
    await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false')
  })

  test('typing into the editor updates the document content', async () => {
    const { page } = handle
    await waitForAppReady(page)

    await createViaButton(page)

    const editor = page.locator('.cm-content')
    await editor.click()
    await page.keyboard.type('Hello from e2e')
    await expect(editor).toContainText('Hello from e2e')
  })
})
