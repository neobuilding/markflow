import { test, expect, type Page } from '@playwright/test'
import {
  launchApp,
  waitForAppReady,
  closeApp,
  installConfirmSpy,
  getConfirmCalls,
  AppHandle,
} from '../helpers/launch'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mkTempDir } from '../helpers/temp'

// D23 guard chain, end to end: an unsaved edit made in the REAL editor must survive a
// document switch DECLINED from the Quick Open palette. The store-level guard is supposed
// to make every entry point safe by construction; this walks the whole chain — editor
// buffer → dirty → guard → confirm → "keep editing" → no switch → focus back to the editor.
//
// The native confirm is spied (installConfirmSpy) so the OS modal never blocks the test,
// while the production dialog:confirm handler still runs and is what gets asserted on.
test.describe('unsaved-switch guard chain (D23)', () => {
  let handle: AppHandle
  let scratch: string

  test.beforeEach(async () => {
    handle = await launchApp()
    scratch = mkTempDir('markflow-e2e-guard-')
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  // Import a real on-disk markdown file through the same IPC the Open File dialog uses,
  // so it carries a real filePath (which content search and the switch both require).
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
      w.__uiStore.getState().setWorkspaceRoot(root)
      w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
      return window.api.documents.setWorkspaceRoot(root)
    }, scratch)
  }

  test('ADR-0040: a Quick Open switch keeps the unsaved draft in its tab without a guard', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await openWorkspace(page)

    const alpha = await importFile(page, 'alpha.md', '# Alpha\n\nbody alpha\n')
    const beta = await importFile(page, 'beta.md', '# Beta\n\nbody beta\n')

    // Open Alpha as a tab, switch to edit mode, and type an unsaved edit.
    await page.evaluate((id) => {
      const w = window as any
      const tabId = w.__tabs.getState().openTab(id, { title: 'alpha.md', editable: true })
      w.__tabs.getState().activateTab(tabId)
      w.__uiStore.getState().setViewMode('edit')
      w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
    }, alpha)
    const cm = page.locator('.cm-content')
    await cm.click()
    await page.keyboard.type('unsaved tail')
    await page.waitForFunction(() => (window as any).__uiStore.getState().dirty === true)

    await installConfirmSpy(handle, { defaultResponse: 0 })

    // Quick Open (Ctrl/Cmd+Shift+K) and pick the OTHER document — a plain tab switch.
    await page.keyboard.press('Control+Shift+k')
    const paletteInput = page.getByTestId('search-input')
    await expect(paletteInput).toBeVisible()
    await paletteInput.pressSequentially('beta')
    await page.getByTestId('search-result').filter({ hasText: 'Beta' }).first().click()

    await expect
      .poll(() => page.evaluate(() => (window as any).__uiStore.getState().activeDocumentId))
      .toBe(beta)
    // No prompt, and the outgoing tab's draft is still registered.
    const calls = await getConfirmCalls(handle)
    expect(calls.filter((c) => c.message?.includes('unsaved'))).toHaveLength(0)
    const kept = await page.evaluate(
      (id) => (window as any).__uiStore.getState().unsavedBuffers[id]?.content ?? '',
      alpha,
    )
    expect(kept).toContain('unsaved tail')
  })
})
