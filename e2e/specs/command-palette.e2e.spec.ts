import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mkTempDir } from '../helpers/temp'

// The Ctrl/Cmd+K command palette is a transient quick-search modal. It reuses the same `SearchPanel`
// the resident sidebar uses, but stays in flat "file name" view and keeps the text scope label
// (the resident surface swaps that for icon-only controls). Its behaviour must not regress, so it
// gets its own e2e surface (previously only covered by a unit test — see plan §5.8 G7).
// DOM is addressed by testids: search-input (the modal field), search-result (flat rows),
// search-scope (the text scope label).
test.describe('command palette (Ctrl+K) modal search', () => {
  let handle: AppHandle
  let scratch: string

  test.beforeEach(async () => {
    handle = await launchApp()
    scratch = mkTempDir('markflow-e2e-cmdpalette-')
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  // Write a real on-disk markdown file, import it through the same IPC the Open File dialog uses
  // (so it carries a real filePath), then activate it.
  async function importFile(page: Page, relPath: string, content: string): Promise<string> {
    const abs = join(scratch, relPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf-8')
    const id = await page.evaluate(
      // `import` resolves to `Document | null`; a null here means the import silently failed, so
      // fail the test loudly instead of propagating an undefined id into the store assertions.
      (f) =>
        window.api.documents.import(f).then((d) => {
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

  test('opens via Ctrl+K, lists matches, shows the scope label, and closes on Esc', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await importFile(page, 'alpha.md', 'needle in alpha\n')

    await page.keyboard.press('Control+k')
    await expect(page.getByTestId('search-input')).toBeVisible()
    // Modal palette keeps the text scope label (resident surface uses icon-only controls instead).
    await expect(page.getByTestId('search-scope')).toBeVisible()

    await page.getByTestId('search-input').pressSequentially('needle')
    await expect(page.getByTestId('search-result')).toHaveCount(1)
    await expect(page.getByTestId('search-result').first()).toContainText('alpha')

    // Esc dismisses the modal and returns keyboard control to the app.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('search-input')).toHaveCount(0)
  })

  test('pressing Ctrl+K again does not stack a second palette (modal guard)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await importFile(page, 'beta.md', 'needle in beta\n')

    await page.keyboard.press('Control+k')
    await expect(page.getByTestId('search-input')).toBeVisible()

    // The palette opts into the same `hasModalSurface` guard as every other window shortcut: a
    // second Ctrl+K while it is open must NOT open a second instance on top.
    await page.keyboard.press('Control+k')
    await expect(page.getByTestId('search-input')).toHaveCount(1)
  })
})
