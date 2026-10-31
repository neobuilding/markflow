import { expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { test } from '../helpers/fixtures'
import {
  expectClipboardAfter,
  readClipboardText,
  snapshotClipboard,
  restoreClipboard,
  clipboardSkipMessage,
  CLIPBOARD_SPEC_SKIP_REASON,
  type ClipboardSnapshot,
} from '../helpers/clipboard'

// C20 / ADR-0024 §10 + ADR-0025 P2 (方案乙): the app has THREE bars — a re-scoped global bar
// (file commands), an editor pane bar (format / find-replace / undo-redo / read-only) and a
// preview pane bar (find / export / copy / more). In split mode each column carries its own bar,
// and the export entry point follows the preview's visibility: exactly ONE export button is ever
// on screen (trade-off 46 — two peer toolbars must not carry the same button side by side).
test.describe('pane toolbars', () => {
  let handle: AppHandle
  // The copy test writes the REAL system clipboard. Snapshot it first so afterEach restores the
  // user's own content; when it cannot be restored the test skips instead of destroying it. The
  // snapshot is only taken when clipboard specs run here, so a normal local run writes nothing
  // (see helpers/clipboard).
  let snap: ClipboardSnapshot | undefined
  test.beforeEach(async ({ clipboardE2e }) => {
    handle = await launchApp()
    snap = clipboardE2e ? await snapshotClipboard(handle) : undefined
  })
  test.afterEach(async () => {
    await restoreClipboard(handle, snap)
    await closeApp(handle)
  })

  async function createDocAndType(page: Page, text: string): Promise<void> {
    await page.getByTestId('new-document-btn').click()
    await expect(page.locator('.cm-content')).toBeVisible()
    await page.locator('.cm-content').click()
    await page.keyboard.type(text)
    await expect(page.locator('.cm-content')).toContainText(text)
  }

  test('split mode gives each column its own bar, and the global bar keeps the file commands', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')
    await page.getByTestId('view-split').click()
    await expect(page.getByTestId('editor-pane')).toBeVisible()
    await expect(page.getByTestId('preview-pane')).toBeVisible()

    // The editor column owns the editor-only clusters (ADR-0024 §10 trade-off 52).
    await expect(page.getByTestId('editor-pane').getByTestId('fmt-**-**')).toBeVisible()
    await expect(page.getByTestId('editor-pane').getByTestId('editor-find-btn')).toBeVisible()
    await expect(page.getByTestId('editor-pane').getByTestId('editor-replace-btn')).toBeVisible()
    await expect(page.getByTestId('editor-pane').getByTestId('editor-undo-btn')).toBeVisible()
    await expect(page.getByTestId('editor-pane').getByTestId('editor-redo-btn')).toBeVisible()
    await expect(page.getByTestId('editor-pane').getByTestId('editor-readonly-btn')).toBeVisible()

    // The preview column owns the preview-only actions.
    await expect(page.getByTestId('preview-pane').getByTestId('preview-find-btn')).toBeVisible()
    await expect(page.getByTestId('preview-pane').getByTestId('preview-copy-btn')).toBeVisible()
    await expect(page.getByTestId('preview-pane').getByTestId('preview-more-btn')).toBeVisible()

    // The global bar keeps the file-lifecycle commands (trade-off 50 / 51 / 53): they must stay
    // reachable in every view mode, which only the always-mounted global bar can guarantee.
    await expect(page.getByTestId('save-btn')).toBeVisible()
    await expect(page.getByTestId('reload-btn')).toBeVisible()
    await expect(page.getByTestId('file-details-btn')).toBeVisible()

    // The editor-only clusters exist ONCE: they sank out of the global bar instead of being
    // duplicated there.
    await expect(page.getByTestId('editor-find-btn')).toHaveCount(1)
    await expect(page.getByTestId('editor-replace-btn')).toHaveCount(1)
    await expect(page.getByTestId('fmt-**-**')).toHaveCount(1)
    await expect(page.getByTestId('editor-readonly-btn')).toHaveCount(1)
  })

  test('the export button follows the preview visibility — exactly one is on screen', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')

    // Edit-only: there is no visible preview to inspect, so the entry point stays on the global bar.
    await page.getByTestId('view-edit').click()
    await expect(page.getByTestId('export-btn')).toHaveCount(1)
    await expect(page.getByTestId('preview-pane').getByTestId('export-btn')).toHaveCount(0)

    // Preview visible: the action sits next to the live rendering it exports.
    await page.getByTestId('view-split').click()
    await expect(page.getByTestId('export-btn')).toHaveCount(1)
    await expect(page.getByTestId('preview-pane').getByTestId('export-btn')).toHaveCount(1)
  })

  test('the editor pane bar undo/redo track the document history', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')

    const undo = page.getByTestId('editor-undo-btn')
    const redo = page.getByTestId('editor-redo-btn')
    // Typing produced history, so undo is available and redo is not.
    await expect(undo).toBeEnabled()
    await expect(redo).toBeDisabled()

    await undo.click()
    // Undo reverts the typed burst (CodeMirror groups it by origin, so assert the change, not
    // the exact grouping).
    await expect(page.locator('.cm-content')).not.toContainText('hello world')
    await expect(redo).toBeEnabled()

    await redo.click()
    await expect(page.locator('.cm-content')).toContainText('hello world')
  })

  test('the preview find panel is anchored inside the preview pane bar, not a floating widget', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')
    await page.getByTestId('view-preview').click()
    await expect(page.locator('article.markdown-preview')).toContainText('hello world')

    // ONE find entry point: the toolbar button. The standalone floating PreviewFindBar widget was
    // removed (ADR-0025 §5 P2.2), so there is no second, floating copy of the button.
    await expect(page.getByTestId('preview-find-btn')).toHaveCount(1)
    await page.getByTestId('preview-find-btn').click()

    // The panel lives INSIDE the preview pane (anchored under the pane bar) and keeps the shared
    // `find-surface` class, so both find surfaces look alike.
    const panel = page.getByTestId('preview-pane').getByTestId('preview-find-bar')
    await expect(panel).toBeVisible()
    await expect(panel).toHaveClass(/find-surface/)
    await expect(page.getByTestId('preview-find-input')).toBeFocused()
  })

  test('the preview bar copies the rendered content to the system clipboard', async ({
    clipboardE2e,
  }) => {
    // Destructive: runs in the e2e-clipboard project only (see helpers/clipboard.ts).
    test.skip(!clipboardE2e, CLIPBOARD_SPEC_SKIP_REASON)
    // Never overwrite a clipboard we cannot put back.
    test.skip(!snap?.restorable, clipboardSkipMessage(snap))
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
})
