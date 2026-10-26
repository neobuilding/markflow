import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mkTempDir } from '../helpers/temp'

// D8: the tree's "Search in This Folder" translates a place into a VISIBLE path scope. The
// chain that matters: right-click a folder → the Search view opens with `./<rel>` written
// into the include row (details auto-expanded, input focused) → the results narrow to that
// folder → ✕ on the row restores the whole root. A scope the user cannot see or audit is
// exactly what this plan outlawed.
test.describe('tree context menu — search in folder (D8)', () => {
  let handle: AppHandle
  let scratch: string

  test.beforeEach(async () => {
    handle = await launchApp()
    scratch = mkTempDir('markflow-e2e-search-in-folder-')
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

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
    return id
  }

  async function openWorkspace(page: Page): Promise<void> {
    await page.evaluate((root) => {
      const w = window as any
      w.__uiStore.getState().setActiveFolder(root)
      w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
      return window.api.documents.setWorkspaceRoot(root)
    }, scratch)
  }

  test('search-in-folder fills the scope, narrows the results, and ✕ restores them', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await openWorkspace(page)

    // The same word in two files, only one of them inside the folder we will search.
    await importFile(page, 'docs/guide.md', 'needle in the guide\n')
    await importFile(page, 'readme.md', 'needle in the readme\n')

    // Right-click the `docs` folder row in the tree → "Search in This Folder".
    await page.getByTestId('sidebar-view-files').click()
    await page.getByTestId('folder-row').filter({ hasText: 'docs' }).click({ button: 'right' })
    await page.getByTestId('side-search-in-folder').click()

    // The Search view takes over, with the scope WRITTEN, VISIBLE, and focused.
    await expect(page.getByTestId('sidebar-view-search')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('search-include')).toHaveValue('./docs')
    await expect(page.getByTestId('search-include')).toBeFocused()

    // The scope narrows the results to the folder's file (the group row shows the title).
    await page.getByTestId('resident-search-input').pressSequentially('needle')
    await expect(page.getByTestId('search-group')).toHaveCount(1)
    await expect(page.getByTestId('search-group')).toContainText('guide')

    // ✕ on the include row restores the whole root.
    await page.getByTestId('search-include-clear').click()
    await expect(page.getByTestId('search-group')).toHaveCount(2)
  })
})
