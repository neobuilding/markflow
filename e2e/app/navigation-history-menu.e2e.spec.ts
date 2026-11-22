import { test, expect, type Page } from '@playwright/test'
import { launchApp, closeApp, type AppHandle } from '../helpers/launch'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir } from '../helpers/temp'
import { resetAppState } from '../helpers/reset'

// The navigation history's right-click menu (ADR-0039 §3.5): choosing an entry JUMPS the cursor
// to it. A jump must never APPEND an entry — otherwise the history would grow every time the
// user went back, and Forward would stop working.
//
// The cursor arithmetic is unit-tested (src/renderer/src/lib/documentNavigation.test.ts,
// src/renderer/src/store/navigationHistory.test.ts). What only a real run can prove is that the
// menu is reachable, that picking an entry moves the active document, and — the observable
// consequence of "no append" — that Forward is still enabled afterwards.
test.describe('navigation history right-click menu', () => {
  test.describe.configure({ mode: 'serial' })
  let handle: AppHandle
  let scratch: string
  let indexFile: string
  let targetFile: string

  test.beforeAll(async () => {
    handle = await launchApp()
  })

  test.beforeEach(async () => {
    await resetAppState(handle)
    scratch = mkTempDir('markflow-history-')
    indexFile = join(scratch, 'index.md')
    targetFile = join(scratch, 'target.md')
    writeFileSync(indexFile, '# Index\n\n[Go](target.md)\n', 'utf-8')
    writeFileSync(targetFile, '# Target\n', 'utf-8')
    await openIndex(handle.page, indexFile)
  })

  test.afterAll(async () => {
    await closeApp(handle)
  })

  test('picking a history entry jumps to it without appending to the history', async () => {
    const { page } = handle
    await page.locator('article.markdown-preview a[href="target.md"]').click()
    await expect.poll(() => activeDocPath(page)).toBe(norm(targetFile))

    const back = page.getByTestId('nav-back-btn')
    const forward = page.getByTestId('nav-forward-btn')
    await expect(forward).toBeDisabled()

    // Right-click the Back button to list the entries before the cursor.
    await back.click({ button: 'right' })
    const item = page.getByTestId('nav-back-item-0')
    await expect(item).toBeVisible()
    await item.click()

    await expect.poll(() => activeDocPath(page)).toBe(norm(indexFile))
    // The jump MOVED the cursor instead of appending: Forward is still available, and it leads
    // back to the document the user came from. An append would have put the cursor at the end
    // of a longer list, leaving Forward disabled.
    await expect(forward).toBeEnabled()
    await forward.click()
    await expect.poll(() => activeDocPath(page)).toBe(norm(targetFile))
  })

  test('right-clicking Forward lists later entries and jumps without appending', async () => {
    const { page } = handle
    await page.locator('article.markdown-preview a[href="target.md"]').click()
    await expect.poll(() => activeDocPath(page)).toBe(norm(targetFile))

    // Move the cursor back so the Forward menu has an entry to offer (ADR-0039 §3.5 requires
    // the same right-click list on BOTH buttons).
    await page.getByTestId('nav-back-btn').click()
    await expect.poll(() => activeDocPath(page)).toBe(norm(indexFile))

    await page.getByTestId('nav-forward-btn').click({ button: 'right' })
    // The testid carries the ABSOLUTE history index, not a relative offset: with two entries
    // and the cursor moved back to 0, the forward entry is index 1.
    const item = page.getByTestId('nav-forward-item-1')
    await expect(item).toBeVisible()
    await item.click()

    await expect.poll(() => activeDocPath(page)).toBe(norm(targetFile))
    // The jump MOVED the cursor, never appended: Back is still available afterwards.
    await expect(page.getByTestId('nav-back-btn')).toBeEnabled()
  })
})

async function openIndex(page: Page, file: string): Promise<void> {
  await page.evaluate(async (file) => {
    const doc = await window.api.documents.import(file)
    const w = window as any
    w.__uiStore.getState().setActiveDocumentId(doc?.id ?? null)
    w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
  }, file)
  await expect(page.locator('article.markdown-preview')).toBeVisible()
}

// The document store keeps forward slashes while node:path.join() uses the host separator, so
// compare paths in one canonical shape (docs/agents/testing.md).
const norm = (p: string | null): string | null => (p ? p.replace(/\\/g, '/') : p)

async function activeDocPath(page: Page): Promise<string | null> {
  const path = await page.evaluate(async () => {
    const w = window as any
    const id = w.__uiStore.getState().activeDocumentId as string | null
    if (!id) return null
    const doc = await window.api.documents.get(id)
    return doc?.filePath ?? null
  })
  return norm(path)
}
