// Context-menu e2e (PLAN §3 / §4 / §5, acceptance §13.1 keyboard + §13.3 real right-click).
// Covers the three P0 surfaces with a REAL Chromium right-click (not jsdom):
//   - editor: menu opens at the pointer; cut/copy are enabled when a selection
//     survives the right-click (G4 selection retention + command snapshot, §3-3/§3-4);
//   - preview: generic / link variants render the expected items (§4);
//   - sidebar: right-clicking a document row shows the file menu (§5);
//   - keyboard: Shift+F10 opens the menu on the focused surface (§1.6 G11).
import { test, expect, type Page } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'

// --- Destructive-action confirm dialog (PLAN §5-4) ---------------------------------
// `dialog:confirm` is implemented in the MAIN process via Electron's `dialog.showMessageBox`
// (an app-modal, OS-level dialog — NOT the browser's `window.confirm`, so Playwright's
// `page.on('dialog')` cannot intercept it). We install a spy on the main-process
// `showMessageBox` so the e2e can both (a) assert the confirm box actually opens and
// (b) auto-answer it (response 1 = OK / 0 = Cancel) to drive the deletion flow.
async function installConfirmSpy(
  electronApp: ElectronApplication,
  response: number,
): Promise<void> {
  // Playwright injects the Electron MODULE as the FIRST argument to electronApp.evaluate,
  // and the user argument as the SECOND. (`require`/`import('electron')` are both unavailable
  // inside the serialized evaluate function, so we use the injected module.) Overriding
  // dialog.showMessageBox lets the e2e assert the confirm box opens and auto-answer it.
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

async function confirmCalls(
  electronApp: ElectronApplication,
): Promise<Array<{ message?: string }>> {
  return electronApp.evaluate(
    () =>
      (globalThis as unknown as { __confirmCalls?: Array<{ message?: string }> }).__confirmCalls ??
      [],
  )
}

test.describe('context menus (PLAN §3/§4/§5)', () => {
  let handle: AppHandle

  test.beforeEach(async () => {
    handle = await launchApp()
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  // Create a memory-only draft through the real sidebar "+" button (handleCreate),
  // focus the CodeMirror content, and type the given text — exactly like a user.
  async function createDocAndType(page: Page, text: string): Promise<void> {
    await page.getByTestId('new-document-btn').click()
    await expect(page.locator('.cm-content')).toBeVisible()
    await page.locator('.cm-content').click()
    await page.keyboard.type(text)
  }

  test('editor: right-click opens the menu; cut/copy stay enabled with a selection (G4 + snapshot)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')
    // Select the whole line via keyboard so the selection is a real CM selection.
    await page.locator('.cm-content').click()
    await page.keyboard.press('End')
    await page.keyboard.press('Shift+Home')
    // Right-click inside the editor surface: the menu appears at the pointer.
    await page.locator('.cm-editor').click({ button: 'right' })
    await expect(page.getByTestId('ctx-cut')).toBeVisible()
    // G4 + §3-4: the selection survives the right-click, so the command snapshot
    // taken on menu open reads hasSelection=true and keeps cut/copy enabled.
    await expect(page.getByTestId('ctx-cut')).not.toHaveAttribute('aria-disabled', 'true')
    await expect(page.getByTestId('ctx-copy')).not.toHaveAttribute('aria-disabled', 'true')
  })

  test('preview: generic right-click offers copy / select-all / view toggles', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, '# Title\n\nbody')
    // Switch to preview-only so the preview <article> is the right-click target.
    await page.getByTestId('view-preview').click()
    const article = page.locator('.markdown-preview')
    await expect(article).toBeVisible()
    // Right-click the body paragraph (NOT the article centre). The capture handler
    // classifies by the element under the pointer, and the article centre can fall on
    // the <h1> for short content — which opens the heading variant instead of the
    // generic one we want to assert here. Clicking the <p> guarantees kind='generic'.
    const body = article.locator('p').first()
    await expect(body).toBeVisible()
    await body.click({ button: 'right' })
    await expect(page.getByTestId('ctx-copy')).toBeVisible()
    await expect(page.getByTestId('ctx-select-all')).toBeVisible()
    await expect(page.getByTestId('ctx-view-editor')).toBeVisible()
  })

  test('preview: right-clicking a link shows open/copy-link/copy/select-all (PLAN §4)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, '[ex](http://example.com)')
    await page.getByTestId('view-preview').click()
    const link = page.locator('.markdown-preview a')
    await expect(link).toBeVisible()
    await link.click({ button: 'right' })
    await expect(page.getByTestId('ctx-open-link')).toBeVisible()
    await expect(page.getByTestId('ctx-copy-link')).toBeVisible()
    await expect(page.getByTestId('ctx-copy')).toBeVisible()
    await expect(page.getByTestId('ctx-select-all')).toBeVisible()
  })

  test('sidebar: right-clicking a draft row shows discard + open + copy-content (PLAN §5)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await page.getByTestId('new-document-btn').click()
    await expect(page.getByTestId('doc-item')).toBeVisible()
    await page.getByTestId('doc-item').first().click({ button: 'right' })
    // A memory-only draft has no file path: delete is labelled "Discard Draft"
    // and the path/filename items are greyed, but open / copy-content remain usable.
    await expect(page.getByTestId('ctx-discard-draft')).toBeVisible()
    await expect(page.getByTestId('ctx-open-document')).toBeVisible()
    await expect(page.getByTestId('ctx-copy-content')).toBeVisible()
    await expect(page.getByTestId('ctx-copy-path')).toHaveAttribute('aria-disabled', 'true')
  })

  test('keyboard: Shift+F10 on the focused editor opens the context menu (G11)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hi')
    await page.locator('.cm-content').focus()
    await page.keyboard.press('Shift+F10')
    // Radix ContextMenuTrigger opens the menu on Shift+F10 / the menu key.
    await expect(page.getByTestId('ctx-undo')).toBeVisible()
  })

  test('keyboard: Shift+F10 on the focused preview opens the context menu (G11)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, '# Title\n\nbody')
    await page.getByTestId('view-preview').click()
    const article = page.locator('.markdown-preview')
    await expect(article).toBeVisible()
    // The preview <article> is focusable (tabIndex={0}), so Shift+F10 opens its menu.
    await article.focus()
    await page.keyboard.press('Shift+F10')
    await expect(page.getByTestId('ctx-copy')).toBeVisible()
  })

  test('sidebar: discarding a draft shows a confirmation and removes it on confirm (PLAN §5-4)', async () => {
    const { electronApp, page } = handle
    await waitForAppReady(page)
    // Auto-answer the native confirm dialog with OK (response 1).
    await installConfirmSpy(electronApp, 1)
    // Create a memory-only draft (no file on disk) via the "+" button.
    await page.getByTestId('new-document-btn').click()
    await expect(page.getByTestId('doc-item')).toBeVisible()
    // Right-click → choose "Discard Draft" (the draft's delete label).
    await page.getByTestId('doc-item').first().click({ button: 'right' })
    await expect(page.getByTestId('ctx-discard-draft')).toBeVisible()
    await page.getByTestId('ctx-discard-draft').click()
    // PLAN §5-4: the destructive action is gated behind the in-app confirm dialog.
    await expect
      .poll(async () => (await confirmCalls(electronApp)).length, { timeout: 5000 })
      .toBeGreaterThan(0)
    const calls = await confirmCalls(electronApp)
    // The draft path uses the discard phrasing (never "Delete"), per PLAN §5-4.
    expect(calls[0].message).toContain('Discard')
    // Confirming removes the draft from the list.
    await expect(page.getByTestId('doc-item')).toHaveCount(0)
  })

  test('sidebar: cancelling the discard confirmation keeps the draft (PLAN §5-4)', async () => {
    const { electronApp, page } = handle
    await waitForAppReady(page)
    // Auto-answer the native confirm dialog with Cancel (response 0).
    await installConfirmSpy(electronApp, 0)
    await page.getByTestId('new-document-btn').click()
    await expect(page.getByTestId('doc-item')).toBeVisible()
    await page.getByTestId('doc-item').first().click({ button: 'right' })
    await expect(page.getByTestId('ctx-discard-draft')).toBeVisible()
    await page.getByTestId('ctx-discard-draft').click()
    await expect
      .poll(async () => (await confirmCalls(electronApp)).length, { timeout: 5000 })
      .toBeGreaterThan(0)
    // Cancelling (response 0) keeps the draft in the list.
    await expect(page.getByTestId('doc-item')).toHaveCount(1)
  })
})
