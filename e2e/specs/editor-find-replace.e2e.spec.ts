import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'

// Editor replace reuses CodeMirror's native search panel; MarkFlow only wires the entry
// points (`Ctrl/Cmd+H` and the toolbar button) onto that panel (see ADR-0012). The panel's
// DOM comes from @codemirror/search: `div.cm-panel.cm-search` with `input[name=search]`,
// `input[name=replace]` and `button[name=replace|replaceAll]`.
//
// The preview pane is read-only and NEVER offers replace, but it does have its own find bar
// (`preview-find-*`), so that surface is covered here too.
test.describe('find and replace', () => {
  let handle: AppHandle
  test.beforeEach(async () => {
    handle = await launchApp()
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  async function createDocAndType(page: Page, text: string): Promise<void> {
    await page.getByTestId('new-document-btn').click()
    await expect(page.locator('.cm-content')).toBeVisible()
    await page.locator('.cm-content').click()
    await page.keyboard.type(text)
    await expect(page.locator('.cm-content')).toContainText(text)
  }

  test('Ctrl+H opens the search panel with a replace field', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')

    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${mod}+H`)

    const panel = page.locator('.cm-search')
    await expect(panel).toBeVisible()
    await expect(panel.locator('input[name="search"]')).toBeVisible()
    await expect(panel.locator('input[name="replace"]')).toBeVisible()
  })

  test('the toolbar replace button opens the same panel', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')

    await page.getByTestId('editor-replace-btn').click()

    await expect(page.locator('.cm-search')).toBeVisible()
    await expect(page.locator('.cm-search input[name="replace"]')).toBeVisible()
  })

  test('Replace swaps the matched text in the document', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')

    await page.getByTestId('editor-replace-btn').click()
    const panel = page.locator('.cm-search')
    await expect(panel).toBeVisible()

    // CodeMirror only commits the query on keyup/change, so type into the fields instead of
    // using `fill()` (which fires `input` only and would leave the query uncommitted).
    await panel.locator('input[name="search"]').pressSequentially('world')
    await panel.locator('input[name="replace"]').pressSequentially('earth')
    // `replaceNext` only rewrites the CURRENT match: with nothing selected it merely moves the
    // selection onto the next match, so select it first (`next`), then replace.
    await panel.locator('button[name="next"]').click()
    await panel.locator('button[name="replace"]').click()

    await expect(page.locator('.cm-content')).toContainText('hello earth')
    await expect(page.locator('.cm-content')).not.toContainText('world')
  })

  test('preview find bar highlights a match in the rendered preview', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')

    // The preview renders off-thread with a ~150ms debounce. Wait for it to settle BEFORE
    // searching: the find bar searches once per query change, so searching stale content
    // would leave zero marks even after the preview catches up.
    await expect(page.locator('article.markdown-preview')).toContainText('hello world')

    await page.getByTestId('preview-find-btn').click()
    await expect(page.getByTestId('preview-find-bar')).toBeVisible()

    await page.getByTestId('preview-find-input').pressSequentially('hello')
    await expect(page.locator('mark.preview-find-match')).toHaveCount(1)
  })
})
