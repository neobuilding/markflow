// Clipboard-only cases extracted from e2e/app/pane-toolbars.e2e.spec.ts (ADR-0034).
// Runs only in the e2e-clipboard project; the remaining 17 toolbar cases live in e2e/app.
import { expect, type Page } from '@playwright/test'
import { waitForAppReady, AppHandle } from '../helpers/launch'
import { test } from '../helpers/fixtures'
import { expectClipboardAfter, readClipboardText } from '../helpers/clipboard'

test.describe('pane toolbars — clipboard commands', () => {
  let handle: AppHandle

  // The gate, the launch, the snapshot, the restore and the close are owned by the shared
  // clipboard fixture (helpers/fixtures.ts) — one implementation for all six clipboard specs.
  test.beforeEach(async ({ clipboardApp }) => {
    handle = clipboardApp
  })

  async function createDocAndType(page: Page, text: string): Promise<void> {
    await page.getByTestId('new-document-btn').click()
    await expect(page.locator('.cm-content')).toBeVisible()
    await page.locator('.cm-content').click()
    await page.keyboard.type(text)
    await expect(page.locator('.cm-content')).toContainText(text)
  }

  test('the preview bar copies the rendered content to the system clipboard', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')
    await expect(page.locator('article.markdown-preview')).toContainText('hello world')

    // The bar reuses the ONE rich-copy implementation (previewCopy.requestRichCopy), which selects
    // the whole article when nothing is selected — so the clipboard carries the rendered text.
    await expectClipboardAfter(
      handle,
      () => page.getByTestId('preview-copy-btn').click(),
      () => readClipboardText(handle),
      'hello world',
    )
  })

  test('the inline Copy rendered HTML command writes the HTML source to the clipboard', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')
    await expect(page.locator('article.markdown-preview')).toContainText('hello world')

    // All four preview commands fit at 368px, so the conditional trigger is ABSENT. Copy
    // rendered HTML must therefore be reachable as an ordinary inline button, not a menu entry.
    await expect(page.getByTestId('preview-more-btn')).toHaveCount(0)
    await expectClipboardAfter(
      handle,
      () => page.getByTestId('preview-copy-html-btn').click(),
      () => readClipboardText(handle),
      'hello world',
    )
    // It is the HTML SOURCE (plain text), distinct from the rich-text copy command.
    expect(await readClipboardText(handle)).toContain('<')
  })
})
