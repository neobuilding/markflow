import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'

test.describe('save and export', () => {
  let handle: AppHandle
  test.beforeEach(async () => {
    handle = await launchApp()
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

    const outPath = join(tmpdir(), `markflow-e2e-${Date.now()}.md`)
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

    const outPath = join(tmpdir(), `markflow-e2e-export-${Date.now()}.html`)
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
})
