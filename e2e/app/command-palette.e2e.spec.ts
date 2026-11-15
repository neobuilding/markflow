import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mkTempDir } from '../helpers/temp'

// The Ctrl/Cmd+Shift+K command palette is a transient "Go to file" modal (ADR-0023): file names
// and paths only, NO body search and NO scope. It is not the Search view — that is the sidebar's
// job. (The chord MOVED here from Ctrl/Cmd+K when ADR-0032 gave ⌘K to the editor's Link action.)
// One app launch for the file; each scenario keeps its own labelled step. Each step imports a
// DISTINCT file and closes the modal before the next one, so no state leaks between steps.
test.describe('command palette (Ctrl+Shift+K) — go to file', () => {
  let handle: AppHandle
  let scratch: string

  test.beforeAll(async () => {
    handle = await launchApp()
    scratch = mkTempDir('markflow-e2e-cmdpalette-')
  })
  test.afterAll(async () => {
    await closeApp(handle)
  })

  // Write a real on-disk markdown file, import it through the same IPC the Open File dialog uses
  // (so it carries a real filePath), then activate it.
  async function importFile(page: Page, relPath: string, content: string): Promise<string> {
    const abs = join(scratch, relPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf-8')
    const id = await page.evaluate(
      (f) =>
        window.api.documents.import(f).then((d: any) => {
          if (!d) throw new Error('documents.import returned null')
          return d.id
        }),
      abs,
    )
    await page.evaluate((docId) => {
      const w = window as any
      w.__uiStore.getState().setActiveDocumentId(docId)
      w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
    }, id)
    return id
  }

  async function closePalette(page: Page) {
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('search-input')).toHaveCount(0)
  }

  test('go-to-file palette: filename matches, modal guard, and the reserved Ctrl+K', async () => {
    const { page } = handle
    await waitForAppReady(page)

    await test.step('opens via Ctrl+Shift+K, lists filename matches, and closes on Esc', async () => {
      await importFile(page, 'alpha.md', 'needle in alpha\n')

      await page.keyboard.press('Control+Shift+k')
      await expect(page.getByTestId('search-input')).toBeVisible()

      // The palette matches FILE NAMES, not body text: a content word finds nothing here, while a
      // filename glob does (the separation from the Search view is the whole point).
      await page.getByTestId('search-input').pressSequentially('needle')
      await expect(page.getByTestId('search-result')).toHaveCount(0)

      // Only alpha.md exists at this point, so the glob resolves to exactly one row.
      await page.getByTestId('search-input').fill('*.md')
      await expect(page.getByTestId('search-result')).toHaveCount(1)
      await expect(page.getByTestId('search-result').first()).toContainText('alpha')

      // Esc dismisses the modal and returns keyboard control to the app.
      await closePalette(page)
    })

    await test.step('pressing Ctrl+Shift+K again does not stack a second palette', async () => {
      await importFile(page, 'beta.md', 'needle in beta\n')

      await page.keyboard.press('Control+Shift+k')
      await expect(page.getByTestId('search-input')).toBeVisible()

      // The palette opts into the same `hasModalSurface` guard as every other window shortcut: a
      // second Ctrl+Shift+K while it is open must NOT open a second instance on top.
      await page.keyboard.press('Control+Shift+k')
      await expect(page.getByTestId('search-input')).toHaveCount(1)
      await closePalette(page)
    })

    // ADR-0032: ⌘K is the editor's Link action now, so the palette must NOT answer to it any more.
    await test.step("plain Ctrl+K does not open the palette — that key is the editor's Link action", async () => {
      await importFile(page, 'gamma.md', 'needle in gamma\n')

      await page.keyboard.press('Control+k')
      await expect(page.getByTestId('search-input')).toHaveCount(0)
    })
  })
})
