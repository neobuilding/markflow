// Clipboard-only cases extracted from e2e/app/context-menu.e2e.spec.ts (ADR-0034).
// Real Chromium copy event + real OS clipboard; runs only in the e2e-clipboard project.
import { expect, type Page } from '@playwright/test'
import { waitForAppReady, AppHandle } from '../helpers/launch'
import { test } from '../helpers/fixtures'
import { readClipboardHtml, readClipboardText, readClipboardTypes } from '../helpers/clipboard'

test.describe('context menus — clean copy payload', () => {
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
  }

  // Mechanism guard. The menu's "Copy" fires `document.execCommand('copy')` and relies on the
  // resulting `copy` event reaching the preview <article>'s handler (which writes the CLEAN
  // payload: internal attrs stripped, images inlined). That is NOT self-evident: the Radix menu
  // content lives in a PORTAL under document.body, so if focus sat on the menu item the event could
  // be dispatched OUTSIDE #root/<article> and React's delegated onCopy would never run — silently
  // falling back to the browser's "dirty" native copy (R6/R3 broken, images not inlined). jsdom
  // cannot catch that (no execCommand), so the mechanism is pinned here with a REAL Chromium copy
  // event plus a read-back of the real system clipboard.
  test('preview: menu Copy reaches the preview copy handler and lands a clean payload (R3/R6)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, '# Title\n\n```js\nconst x = 1\n```\n')
    await page.getByTestId('view-preview').click()
    const article = page.locator('.markdown-preview')
    await expect(article).toBeVisible()
    // Record where every `copy` event lands (capture phase sees it regardless of target).
    await page.evaluate(() => {
      const w = window as any
      w.__copyProbe = { count: 0, inArticle: false }
      document.addEventListener(
        'copy',
        (e) => {
          const t = e.target as HTMLElement | null
          w.__copyProbe.count += 1
          w.__copyProbe.inArticle = !!t?.closest?.('article.markdown-preview')
        },
        true,
      )
    })
    // Right-click the code block → generic variant (pre → not image / link / mermaid).
    await article.locator('pre').first().click({ button: 'right' })
    await page.getByTestId('preview-copy').click()
    await expect
      .poll(() => page.evaluate(() => (window as any).__copyProbe.count))
      .toBeGreaterThan(0)
    // The event must have reached the article, otherwise our clean writer is bypassed.
    expect(await page.evaluate(() => (window as any).__copyProbe.inArticle)).toBe(true)
    await expect.poll(() => readClipboardText(handle), { timeout: 15_000 }).toContain('const x = 1')
    const [html, types, text] = await Promise.all([
      readClipboardHtml(handle),
      readClipboardTypes(handle),
      readClipboardText(handle),
    ])
    // Both halves must be present (the browser packed text/plain + text/html from setData).
    expect(types).toContain('text/html')
    expect(html).toContain('<pre')
    expect(html).toContain('const')
    expect(text).toContain('const x = 1')
    // R6: no internal marker survived into the pasted HTML.
    expect(html).not.toContain('data-lang')
    expect(html).not.toContain('data-line')
    expect(html).not.toContain('data-mermaid')
    expect(html).not.toContain('data-baked')
    // markdown-it-anchor's heading tabindex must be stripped too.
    expect(html).not.toContain('tabindex')
  })
})
