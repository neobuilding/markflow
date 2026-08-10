import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test.describe('file round-trip (open / edit / save / reopen)', () => {
  let handle: AppHandle
  let scratch: string

  test.beforeEach(async () => {
    handle = await launchApp()
    scratch = mkdtempSync(join(tmpdir(), 'markflow-e2e-'))
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  // Activate a document by id using the REAL UI store instance (exposed on
  // window only in dev). This drives the exact same store the app subscribes to.
  async function activateById(page: Page, id: string, editable = false) {
    await page.evaluate(
      (args) => {
        const w = window as any
        w.__uiStore.getState().setActiveDocumentId(args.id)
        if (args.editable) w.__uiStore.getState().setEditable(true)
        w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
      },
      { id, editable },
    )
  }

  test('opening a disk markdown file loads it into the editor', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // Write a real .md file to disk, then "open" it via the same import IPC
    // the Open File dialog would use.
    const file = join(scratch, 'sample.md')
    writeFileSync(file, '# Hello from disk\n\nThis came from a file.', 'utf-8')

    const id = await page.evaluate(
      (f) => window.api.documents.import(f).then((d: any) => d.id),
      file,
    )
    expect(id).toBeTruthy()

    await activateById(page, id)

    // The editor shows the file's content.
    await expect(page.locator('.cm-content')).toBeVisible()
    await expect(page.locator('.cm-content')).toContainText('Hello from disk')
  })

  test('editing then Save As writes the new content back to disk', async () => {
    const { page } = handle
    await waitForAppReady(page)

    const file = join(scratch, 'editme.md')
    writeFileSync(file, '# Original\n\nbefore', 'utf-8')
    const id = await page.evaluate(
      (f) => window.api.documents.import(f).then((d: any) => d.id),
      file,
    )
    await activateById(page, id, true)

    // Type into the editor.
    const editor = page.locator('.cm-content')
    await editor.click()
    await page.keyboard.type(' APPENDED')
    await expect(editor).toContainText('APPENDED')

    // Read the live editor text and Save As to a new path.
    const outPath = join(scratch, 'saved.md')
    const liveText = await editor.innerText()
    const saved = await page.evaluate(
      (args) =>
        window.api.documents
          .saveAs(args.id, args.out, { title: 'saved', content: args.text })
          .then((r: any) => r?.filePath ?? null),
      { id, out: outPath, text: liveText },
    )
    expect(saved).toBe(outPath)
    expect(existsSync(outPath)).toBe(true)
    const onDisk = readFileSync(outPath, 'utf-8')
    expect(onDisk).toContain('APPENDED')

    // Re-open the saved file and confirm the edit survived the round-trip.
    const reopenId = await page.evaluate(
      (f) => window.api.documents.import(f).then((d: any) => d.id),
      outPath,
    )
    await activateById(page, reopenId)
    await expect(page.locator('.cm-content')).toContainText('APPENDED')
  })

  test('the Export as HTML dialog opens from the toolbar and shows its controls', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // Need an open document for the export button to be present.
    await page.getByTestId('new-document-btn').click()
    await expect(page.locator('.cm-content')).toBeVisible()

    // Open the export dialog via the toolbar button.
    await page.getByTestId('export-btn').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // Key controls are present: title, theme selector, Export action.
    await expect(dialog.getByRole('heading', { name: /export as html/i })).toBeVisible()
    await expect(dialog.locator('select')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Export' })).toBeVisible()

    // Close it again (cancel) — does not trigger the native save picker.
    await dialog.getByText('Cancel').click()
    await expect(dialog).toBeHidden()
  })
})
