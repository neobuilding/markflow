// Export parity e2e (PLAN C33 / ADR-0024 §11)
// "预览 = 导出" must be an ASSERTION, not a wish. This spec renders the SAME document twice —
// once in the live preview, once as the standalone HTML the export button writes — and compares
// the COMPUTED styles of the code block and of a highlight.js token.
//
// Unit tests can only assert on the exported TEXT (exportParity.test.ts does that); the cascade
// itself (which sheet wins, which token resolves) can only be observed in a real renderer —
// hence this e2e. It is the regression net for the two defects C33 fixed:
//   D3 — exported code blocks had no syntax highlighting (the hljs sheet was not inlined);
//   D4 — KaTeX fonts dangled as relative `url(fonts/…)` refs once the file left the app.
//
// The exported document is opened in a REAL second Electron window (not an iframe): the app's
// CSP has no `frame-src`, so an in-app frame would be blocked, and a separate window is what a
// user actually opens the exported file in.
import { test, expect, type Page } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { mkTempDir } from '../helpers/temp'

const MD = [
  '# Code',
  '',
  '```js',
  'const answer = 42',
  'function go() { return answer }',
  '```',
  '',
].join('\n')

interface BoxStyle {
  bg: string
  border: string
  radius: string
  padding: string
  fontSize: string
  keyword: string | null
}

/** Measure the code-block box + a highlight.js token inside `rootSelector`. */
async function measure(page: Page, rootSelector: string): Promise<BoxStyle | null> {
  return page.evaluate((root) => {
    const scope = document.querySelector(root) as HTMLElement | null
    if (!scope) return null
    const pre = scope.querySelector('pre') as HTMLElement | null
    if (!pre) return null
    const s = getComputedStyle(pre)
    const kw = scope.querySelector('.hljs-keyword') as HTMLElement | null
    return {
      bg: s.backgroundColor,
      border: s.borderTopColor,
      radius: s.borderTopLeftRadius,
      padding: s.paddingTop,
      fontSize: s.fontSize,
      keyword: kw ? getComputedStyle(kw).color : null,
    }
  }, rootSelector)
}

/** Open a file in a second, hidden Electron window; returns its page + a disposer. */
async function openInSecondWindow(
  handle: AppHandle,
  filePath: string,
): Promise<{ page: Page; dispose: () => Promise<void> }> {
  const before = handle.electronApp.windows().length
  const id = await handle.electronApp.evaluate(async ({ BrowserWindow }, url) => {
    const win = new BrowserWindow({ show: false, width: 900, height: 700 })
    await win.loadURL(url)
    return win.id
  }, pathToFileURL(filePath).href)

  let page: Page | undefined
  for (let i = 0; i < 60 && !page; i++) {
    const windows = handle.electronApp.windows()
    if (windows.length > before) page = windows[windows.length - 1]
    else await new Promise((r) => setTimeout(r, 250))
  }
  if (!page) throw new Error('the exported file window never appeared')
  await page.waitForLoadState('domcontentloaded')
  await page.waitForSelector('pre', { timeout: 15_000 })

  // The window must be torn down whatever happens next — a leftover window would keep the app
  // alive and confuse the next test's window bookkeeping.
  const dispose = async (): Promise<void> => {
    await handle.electronApp.evaluate(({ BrowserWindow }, winId) => {
      BrowserWindow.fromId(winId)?.destroy()
    }, id)
  }
  return { page, dispose }
}

test.describe('export parity', () => {
  let handle: AppHandle
  let scratch: string

  test.beforeEach(async () => {
    handle = await launchApp()
    scratch = mkTempDir('markflow-e2e-')
  })

  test.afterEach(async () => {
    await closeApp(handle)
  })

  test('the exported code block is styled exactly like the one in the preview', async () => {
    const { page } = handle
    await waitForAppReady(page)

    const mdPath = join(scratch, 'parity.md')
    writeFileSync(mdPath, MD, 'utf-8')
    const id = await page.evaluate(
      (f) => window.api.documents.import(f).then((d: any) => d.id),
      mdPath,
    )
    await page.evaluate((docId) => {
      const w = window as any
      w.__uiStore.getState().setActiveDocumentId(docId)
      w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
    }, id)

    // The preview must have parsed AND highlighted before we compare anything.
    await expect(page.locator('.markdown-body pre.hljs')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.markdown-body .hljs-keyword').first()).toBeVisible({
      timeout: 30_000,
    })

    const preview = await measure(page, 'article.markdown-body')
    expect(preview, 'the preview code block must be measurable').not.toBeNull()
    expect(preview!.keyword, 'the preview must highlight the keyword').not.toBeNull()

    // Export through the REAL dialog so the file on disk is the real artifact.
    await page.getByTestId('export-btn').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    const htmlPath = mdPath.replace(/\.md$/i, '.html')
    await expect(dialog.locator('input[readonly]')).toHaveValue(htmlPath, { timeout: 15_000 })
    await dialog.getByRole('button', { name: 'Export' }).click()
    await expect
      .poll(() => existsSync(htmlPath), {
        timeout: 30_000,
        message: 'exported html was not written',
      })
      .toBe(true)

    const written = readFileSync(htmlPath, 'utf-8')
    // D3: the exported file carries the highlight.js palette.
    expect(written).toContain('.hljs-keyword')
    // D4: no dangling relative font reference survives.
    expect(written).not.toContain('url(fonts/')

    const { page: exportedPage, dispose } = await openInSecondWindow(handle, htmlPath)
    try {
      const exported = await measure(exportedPage, 'body.markdown-body')
      expect(exported, 'the exported code block must be measurable').not.toBeNull()
      expect(exported!.keyword, 'the export must highlight the keyword').not.toBeNull()

      // The whole point: same box, same colours, in both renderings.
      expect(exported).toEqual(preview)
    } finally {
      await dispose()
    }
  })

  test('the dark code block keeps its surface background in both renderings', async () => {
    const { page } = handle
    await waitForAppReady(page)

    const mdPath = join(scratch, 'parity-dark.md')
    writeFileSync(mdPath, MD, 'utf-8')
    const id = await page.evaluate(
      (f) => window.api.documents.import(f).then((d: any) => d.id),
      mdPath,
    )
    await page.evaluate((docId) => {
      const w = window as any
      w.__uiStore.getState().setActiveDocumentId(docId)
      w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
    }, id)

    // Switch the app to dark; the export dialog's default theme is "current", so the exported
    // document is the dark variant too.
    await page.evaluate(() => {
      ;(window as any).__uiStore.getState().setTheme('dark')
    })

    await expect(page.locator('.markdown-body pre.hljs')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.markdown-body .hljs-keyword').first()).toBeVisible({
      timeout: 30_000,
    })

    const preview = await measure(page, 'article.markdown-body')
    expect(preview, 'the preview code block must be measurable').not.toBeNull()
    // A transparent code block is the D-A defect: the dark highlight.js palette used to set
    // `background: transparent` with the same specificity as the box rule, and it won.
    expect(preview!.bg, 'the dark code block must keep its surface background').not.toBe(
      'rgba(0, 0, 0, 0)',
    )

    await page.getByTestId('export-btn').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    const htmlPath = mdPath.replace(/\.md$/i, '.html')
    await expect(dialog.locator('input[readonly]')).toHaveValue(htmlPath, { timeout: 15_000 })
    await dialog.getByRole('button', { name: 'Export' }).click()
    await expect
      .poll(() => existsSync(htmlPath), {
        timeout: 30_000,
        message: 'exported html was not written',
      })
      .toBe(true)

    const { page: exportedPage, dispose } = await openInSecondWindow(handle, htmlPath)
    try {
      const exported = await measure(exportedPage, 'body.markdown-body')
      expect(exported, 'the exported code block must be measurable').not.toBeNull()
      expect(exported).toEqual(preview)
    } finally {
      await dispose()
    }
  })
})
