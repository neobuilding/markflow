import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mkTempDir } from '../helpers/temp'

// D28 / ADR-0023 item 15, end to end: §5.2 lets an unsaved buffer be SEARCHED, but §5.5.3 makes
// replace skip it. The consequence is a user who can see a hit they cannot replace — so the plan
// has to SAY it dropped that file, and it has to write nothing at all.
//
// This walks the real chain: on-disk file → editor edit → dirty buffer → search still finds it →
// Replace All → the plan drops it with a visible reason → the file on disk is untouched.
test.describe('replace skips unsaved buffers and says so (D28)', () => {
  let handle: AppHandle
  let scratch: string

  test.beforeEach(async () => {
    handle = await launchApp()
    scratch = mkTempDir('markflow-e2e-replace-dirty-')
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

  test('names the dropped file instead of silently writing fewer files', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await openWorkspace(page)

    const note = await importFile(page, 'note.md', '# Note\n\ncat on disk\n')

    // Open it and type an unsaved edit — the real editor path, so the document is genuinely
    // in `unsavedBuffers` (which is what the replace plan refuses to write over).
    await page.evaluate((id) => {
      const w = window as any
      w.__uiStore.getState().setActiveDocumentId(id)
      w.__uiStore.getState().setEditable(true)
      w.__uiStore.getState().setViewMode('edit')
      w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
    }, note)
    await page.locator('.cm-content').click()
    await page.keyboard.type(' unsaved tail')
    await page.waitForFunction(() => (window as any).__uiStore.getState().dirty === true)

    // Search still finds it (§5.2): the hit is visible even though it cannot be replaced.
    await page.getByTestId('activity-bar-search').click()
    await page.getByTestId('resident-search-input').pressSequentially('cat')
    await expect(page.getByTestId('search-match').first()).toBeVisible()

    // …but Replace All must drop it and say why.
    await page.getByTestId('search-toggle-replace').click()
    await page.getByTestId('search-replace-input').fill('dog')
    await page.getByTestId('search-replace-all').click()

    const skipped = page.getByTestId('search-replace-skipped')
    await expect(skipped).toBeVisible()
    await expect(skipped).toContainText(/unsaved|未保存/i)
    // Zero files planned → zero confirmed → zero written.
    await expect(page.getByTestId('search-replace-plan')).toContainText('0')
    expect(readFileSync(join(scratch, 'note.md'), 'utf-8')).toContain('cat on disk')
    expect(readFileSync(join(scratch, 'note.md'), 'utf-8')).not.toContain('dog')
  })
})
