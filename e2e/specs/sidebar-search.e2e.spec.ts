import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mkTempDir } from '../helpers/temp'

// The sidebar hosts a resident, collapsible "search in files" panel (the Phase 4 / Q26 design).
// It reuses the same `SearchPanel` the Ctrl/Cmd+K palette uses, but in content mode it renders
// per-file groups of hit rows (each `<mark>`-highlighted) that open the document AND jump the
// editor to the hit offset. Its collapse state is session-only (never persisted, Q20).
// DOM is addressed by testids: resident-search-{collapse,expand,input}, search-{group,match,
// result,summary}, search-mode-{content,filename}.
test.describe('sidebar resident search panel', () => {
  let handle: AppHandle
  let scratch: string

  test.beforeEach(async () => {
    handle = await launchApp()
    scratch = mkTempDir('markflow-e2e-')
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  // Write a real on-disk markdown file, import it through the same IPC the Open File dialog
  // uses (so it carries a real filePath, which filename-mode glob requires), then activate it.
  async function importFile(page: Page, relPath: string, content: string): Promise<string> {
    const abs = join(scratch, relPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf-8')
    const id = await page.evaluate(
      (f) => window.api.documents.import(f).then((d: any) => d.id),
      abs,
    )
    await page.evaluate((docId) => {
      const w = window as any
      w.__uiStore.getState().setActiveDocumentId(docId)
      w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
    }, id)
    return id
  }

  test('is visible above the tree, collapsible, and its state is never persisted', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // Expanded by default: a header row plus the input.
    await expect(page.getByTestId('resident-search-collapse')).toBeVisible()
    await expect(page.getByTestId('resident-search-input')).toBeVisible()

    // Collapse to a single header row.
    await page.getByTestId('resident-search-collapse').click()
    await expect(page.getByTestId('resident-search-expand')).toBeVisible()
    await expect(page.getByTestId('resident-search-input')).toHaveCount(0)

    // Nothing about the collapsed state is written to persistent storage (Q20: no persisted
    // settings) — it lives only in the in-memory store for this session.
    const persisted = await page.evaluate(() =>
      Object.keys(window.localStorage).filter((k) => /resident|collapsed|search/i.test(k)),
    )
    expect(persisted).toHaveLength(0)

    // Expand again for the next assertion.
    await page.getByTestId('resident-search-expand').click()
    await expect(page.getByTestId('resident-search-input')).toBeVisible()
  })

  test('content mode groups hits per file with per-group counts and the global summary', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // Two files, three total occurrences of "needle".
    await importFile(page, 'alpha.md', 'needle one\n\nsecond needle here\n')
    await importFile(page, 'beta.md', 'a needle in beta\n')

    await page.getByTestId('search-mode-content').click()
    await page.getByTestId('resident-search-input').pressSequentially('needle')

    // One group per file, one row per in-document occurrence.
    await expect(page.getByTestId('search-group')).toHaveCount(2)
    await expect(page.getByTestId('search-match')).toHaveCount(3)

    // Global hit summary.
    await expect(page.getByTestId('search-summary')).toContainText('3 matches in 2 files')

    // Per-group hit counts (order-independent).
    await expect(page.getByTestId('search-group').filter({ hasText: 'Alpha' })).toContainText('2')
    await expect(page.getByTestId('search-group').filter({ hasText: 'Beta' })).toContainText('1')
  })

  test('clicking a hit in the open document jumps the editor to the hit offset', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // A single, already-open document: clicking its hit selects the match in place.
    await importFile(page, 'solo.md', 'alpha needle beta')
    await expect(page.locator('.cm-content')).toContainText('alpha needle beta')

    await page.getByTestId('search-mode-content').click()
    await page.getByTestId('resident-search-input').pressSequentially('needle')
    await expect(page.getByTestId('search-match')).toHaveCount(1)

    await page.getByTestId('search-match').first().click()

    // The jump placed a selection on the matched range in the editor.
    await expect(page.locator('.cm-content')).toBeVisible()
    await expect
      .poll(async () => page.locator('.cm-selectionBackground').count(), { timeout: 5000 })
      .toBeGreaterThan(0)
  })

  test('the query field is styled as a field, not as static text', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // Regression: the magnifier, a borderless transparent <input> and the clear button floated
    // loose on the panel background, so the query box read as a caption rather than a field.
    const box = page.getByTestId('resident-search-box')
    await expect(box).toBeVisible()
    const style = await box.evaluate((el) => {
      const cs = getComputedStyle(el)
      return { borderTop: cs.borderTopWidth, background: cs.backgroundColor }
    })
    expect(parseFloat(style.borderTop)).toBeGreaterThan(0)
    expect(style.background).not.toBe('rgba(0, 0, 0, 0)')

    const fieldBox = await box.boundingBox()
    expect(fieldBox).not.toBeNull()

    // Both the magnifier and the clear affordance sit INSIDE the field's bounds.
    const iconBox = await box.locator('svg').first().boundingBox()
    expect(iconBox).not.toBeNull()
    expect(iconBox!.x).toBeGreaterThanOrEqual(fieldBox!.x)
    expect(iconBox!.x + iconBox!.width).toBeLessThanOrEqual(fieldBox!.x + fieldBox!.width)

    // §3.4: the row ends with an Esc hint, so the collapse shortcut is discoverable rather than
    // being an invisible key. It must sit inside the field and carry an explanation.
    const esc = page.getByTestId('resident-search-esc')
    await expect(esc).toBeVisible()
    const escBox = await esc.boundingBox()
    expect(escBox).not.toBeNull()
    expect(await esc.getAttribute('title')).toBeTruthy()
    expect(escBox!.x).toBeGreaterThanOrEqual(fieldBox!.x)
    expect(escBox!.x + escBox!.width).toBeLessThanOrEqual(fieldBox!.x + fieldBox!.width)
  })

  test('filename mode matches a basename glob at any depth', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // A file nested in a subfolder: a basename glob must still match it (Q8).
    await importFile(page, join('sub', 'deep.md'), '# Deep\n')

    await page.getByTestId('search-mode-filename').click()
    await page.getByTestId('resident-search-input').pressSequentially('*.md')

    // Filename mode lists flat file rows (grouping is content-mode only).
    await expect(page.getByTestId('search-result')).toHaveCount(1)
    await expect(page.getByTestId('search-result').first()).toContainText('deep')
  })
})
