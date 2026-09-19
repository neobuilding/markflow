import { expect, test, type Page } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppHandle, closeApp, launchApp, waitForAppReady } from '../helpers/launch'
import { mkTempDir } from '../helpers/temp'

// Long enough for franc's statistical detector to be confident.
const ZH =
  '我们生活在一个充满变化的时代。技术的进步正在深刻地影响着每一个人的日常生活。学习新知识、适应新环境，已经成为现代人不可或缺的能力。'

test.describe('save and export', () => {
  let handle: AppHandle
  let scratch: string
  test.beforeEach(async () => {
    handle = await launchApp()
    scratch = mkTempDir('markflow-e2e-')
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  async function createViaButton(page: Page) {
    await page.getByTestId('new-document-btn').click()
    await expect(page.locator('.cm-content')).toBeVisible()
  }

  // Find the most recently created document id via the main process.
  async function latestDocId(page: Page): Promise<string> {
    return page.evaluate(() => {
      const w = window as any
      return w.api.documents.list().then((list: any[]) => list[list.length - 1]?.id ?? '')
    })
  }

  test('Save As writes the document to disk and records the path', async () => {
    const { page } = handle
    await waitForAppReady(page)

    await createViaButton(page)
    const id = await latestDocId(page)
    expect(id).toBeTruthy()

    // Write into the test's own tracked scratch dir, not the temp root: this file is
    // e2e-owned garbage and goes away with the scratch dir, leaving no stray files.
    const outPath = join(scratch, 'save-as.md')
    const savedPath = await page.evaluate(
      (args) => {
        const w = window as any
        return w.api.documents
          .saveAs(args.id, args.path, {
            title: 'SaveTest',
            content: '# Save Test\n\nHello from e2e.',
          })
          .then((r: any) => r?.filePath ?? null)
      },
      { id, path: outPath },
    )

    expect(savedPath).toBe(outPath)
    expect(existsSync(outPath)).toBe(true)
    const onDisk = readFileSync(outPath, 'utf-8')
    expect(onDisk).toContain('Hello from e2e.')
  })

  test('export to HTML writes a standalone file via the main process', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // Same ownership rule as above: keep the artifact inside the tracked scratch dir.
    const outPath = join(scratch, 'export-target.html')
    await page.evaluate((targetPath) => {
      const w = window as any
      const html =
        '<!doctype html><html><head><title>x</title></head><body><h1>Exported</h1></body></html>'
      return w.api.export
        .embedImages(html)
        .then((embedded: string) => w.api.export.write(targetPath, embedded, true))
    }, outPath)

    expect(existsSync(outPath)).toBe(true)
    const written = readFileSync(outPath, 'utf-8')
    expect(written).toContain('Exported')
  })

  test('theme API reflects a valid theme value', async () => {
    const { page } = handle
    await waitForAppReady(page)

    const theme = await page.evaluate(() => (window as any).api.app.getTheme())
    expect(['light', 'dark', 'system']).toContain(theme)
  })

  // Open a real .md file (so the export dialog can derive a target path from
  // doc.filePath) and activate it through the REAL UI store.
  async function openDiskDoc(page: Page, content: string, name: string): Promise<string> {
    const file = join(scratch, `${name}.md`)
    writeFileSync(file, content, 'utf-8')
    const id = await page.evaluate(
      (f) => window.api.documents.import(f).then((d: any) => d.id),
      file,
    )
    expect(id).toBeTruthy()
    await page.evaluate((docId) => {
      const w = window as any
      w.__uiStore.getState().setActiveDocumentId(docId)
      w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
    }, id)
    await expect(page.locator('.cm-content')).toBeVisible()
    return file
  }

  // Drive the REAL Export-as-HTML dialog (toolbar button -> dialog -> Export) and
  // return the path it wrote. `franc` is lazy-loaded inside this path, so this is
  // the only place the <html lang> resolution is exercised end to end.
  async function exportViaDialog(page: Page, mdPath: string): Promise<string> {
    // The preview must have parsed first: export reuses its sanitized HTML and the
    // raw markdown (for lang detection), both stashed by MarkdownPreview.
    await expect(page.locator('.markdown-preview p').first()).toBeVisible({ timeout: 30_000 })

    const htmlPath = mdPath.replace(/\.md$/i, '.html')
    await page.getByTestId('export-btn').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // The derived target path must be filled in; if it were empty, clicking Export
    // would open the NATIVE save picker and the test would hang.
    await expect(dialog.locator('input[readonly]')).toHaveValue(htmlPath, { timeout: 15_000 })

    await dialog.getByRole('button', { name: 'Export' }).click()
    await expect
      .poll(() => existsSync(htmlPath), {
        timeout: 30_000,
        message: 'exported html was not written',
      })
      .toBe(true)
    // The dialog closes on success.
    await expect(dialog).toBeHidden({ timeout: 15_000 })
    return htmlPath
  }

  test('exported HTML carries a detected <html lang> (zh-CN)', async () => {
    const { page } = handle
    await waitForAppReady(page)

    const mdPath = await openDiskDoc(page, `# 中文标题\n\n${ZH}\n`, 'lang-detect')
    const htmlPath = await exportViaDialog(page, mdPath)

    const written = readFileSync(htmlPath, 'utf-8')
    expect(written).toContain('<html lang="zh-CN"')
    expect(written).toContain(ZH)
  })

  test('frontmatter lang wins over content detection in the exported HTML', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // Body is clearly Chinese, but an explicit `lang: ja` must win.
    const mdPath = await openDiskDoc(page, `---\nlang: ja\n---\n\n${ZH}\n`, 'lang-frontmatter')
    const htmlPath = await exportViaDialog(page, mdPath)

    const written = readFileSync(htmlPath, 'utf-8')
    expect(written).toContain('<html lang="ja"')
    expect(written).toContain(ZH)
  })
})
