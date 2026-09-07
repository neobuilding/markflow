// Context-menu e2e ( / / , acceptance keyboard + real right-click)
// Covers the three P0 surfaces with a REAL Chromium right-click (not jsdom):
//   - editor: menu opens at the pointer; cut/copy are enabled when a selection
// survives the right-click (G4 selection retention + command snapshot, /);
// preview: generic / link variants render the expected items ;
// sidebar: right-clicking a document row shows the file menu ;
// keyboard: Shift+F10 opens the menu on the focused surface ( G11)
import { test, expect, type Page } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'

// Destructive-action confirm dialog ---------------------------------
// `dialog:confirm` is implemented in the MAIN process via Electron's `dialog.showMessageBox`
// (an app-modal, OS-level dialog NOT the browser's `window.confirm`, so Playwright's
// `page.on('dialog')` cannot intercept it). We install a spy on the main-process
// `showMessageBox` so the e2e can both (a) assert the confirm box actually opens and
// (b) auto-answer it (response 1 = OK / 0 = Cancel) to drive the deletion flow.
async function installConfirmSpy(
  electronApp: ElectronApplication,
  response: number,
): Promise<void> {
  // Playwright injects the Electron MODULE as the FIRST argument to electronApp.evaluate,
  // and the user argument as the SECOND. (`require`/`import('electron')` are both unavailable
  // inside the serialized evaluate function, so we use the injected module.) Overriding
  // dialog.showMessageBox lets the e2e assert the confirm box opens and auto-answer it.
  await (
    electronApp.evaluate as unknown as (
      fn: (electronMod: { dialog: { showMessageBox: unknown } }, resp: number) => void,
      arg: number,
    ) => Promise<void>
  )((electronMod, resp) => {
    const dialog = electronMod.dialog
    const g = globalThis as unknown as { __confirmCalls?: unknown[]; __confirmResponse?: number }
    g.__confirmCalls = []
    g.__confirmResponse = resp
    dialog.showMessageBox = async (opts: { message?: string }) => {
      g.__confirmCalls!.push(opts)
      return { response: g.__confirmResponse!, checkboxChecked: false }
    }
  }, response)
}

async function confirmCalls(
  electronApp: ElectronApplication,
): Promise<Array<{ message?: string }>> {
  return electronApp.evaluate(
    () =>
      (globalThis as unknown as { __confirmCalls?: Array<{ message?: string }> }).__confirmCalls ??
      [],
  )
}

test.describe('context menus (PLAN §3/§4/§5)', () => {
  let handle: AppHandle

  test.beforeEach(async () => {
    handle = await launchApp()
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  // Create a memory-only draft through the real sidebar "+" button (handleCreate),
  // focus the CodeMirror content, and type the given text exactly like a user
  async function createDocAndType(page: Page, text: string): Promise<void> {
    await page.getByTestId('new-document-btn').click()
    await expect(page.locator('.cm-content')).toBeVisible()
    await page.locator('.cm-content').click()
    await page.keyboard.type(text)
  }

  test('editor: right-click opens the menu; cut/copy stay enabled with a selection (G4 + snapshot)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')
    // Select the whole line via keyboard so the selection is a real CM selection.
    await page.locator('.cm-content').click()
    await page.keyboard.press('End')
    await page.keyboard.press('Shift+Home')
    // Right-click inside the editor surface: the menu appears at the pointer.
    await page.locator('.cm-editor').click({ button: 'right' })
    await expect(page.getByTestId('me-cut')).toBeVisible()
    // G4 + : the selection survives the right-click, so the command snapshot
    // taken on menu open reads hasSelection=true and keeps cut/copy enabled.
    await expect(page.getByTestId('me-cut')).not.toHaveAttribute('aria-disabled', 'true')
    await expect(page.getByTestId('me-copy')).not.toHaveAttribute('aria-disabled', 'true')
  })

  test('preview: generic right-click offers copy / select-all / view toggles', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, '# Title\n\nbody')
    // Switch to preview-only so the preview <article> is the right-click target.
    await page.getByTestId('view-preview').click()
    const article = page.locator('.markdown-preview')
    await expect(article).toBeVisible()
    // Right-click the body paragraph (NOT the article centre). The capture handler
    // classifies by the element under the pointer, and the article centre can fall on
    // the <h1> for short content which opens the heading variant instead of the
    // generic one we want to assert here. Clicking the <p> guarantees kind='generic'.
    const body = article.locator('p').first()
    await expect(body).toBeVisible()
    await body.click({ button: 'right' })
    await expect(page.getByTestId('preview-copy')).toBeVisible()
    await expect(page.getByTestId('preview-select-all')).toBeVisible()
    await expect(page.getByTestId('preview-view-editor')).toBeVisible()
  })

  test('preview: right-clicking a link shows open/copy-link/copy/select-all (PLAN §4)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, '[ex](http://example.com)')
    await page.getByTestId('view-preview').click()
    const link = page.locator('.markdown-preview a')
    await expect(link).toBeVisible()
    await link.click({ button: 'right' })
    await expect(page.getByTestId('preview-open-link')).toBeVisible()
    await expect(page.getByTestId('preview-copy-link')).toBeVisible()
    await expect(page.getByTestId('preview-copy')).toBeVisible()
    await expect(page.getByTestId('preview-select-all')).toBeVisible()
  })

  test('sidebar: right-clicking a draft row shows discard + open + copy-content (PLAN §5)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await page.getByTestId('new-document-btn').click()
    await expect(page.getByTestId('doc-item')).toBeVisible()
    await page.getByTestId('doc-item').first().click({ button: 'right' })
    // A memory-only draft has no file path: delete is labelled "Discard Draft"
    // and the path/filename items are greyed, but open / copy-content remain usable.
    await expect(page.getByTestId('side-discard-draft')).toBeVisible()
    await expect(page.getByTestId('side-open-document')).toBeVisible()
    await expect(page.getByTestId('side-copy-content')).toBeVisible()
    await expect(page.getByTestId('side-copy-path')).toHaveAttribute('aria-disabled', 'true')
  })

  test('keyboard: Shift+F10 on the focused editor opens the context menu (G11)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hi')
    await page.locator('.cm-content').focus()
    await page.keyboard.press('Shift+F10')
    // Radix ContextMenuTrigger opens the menu on Shift+F10 / the menu key.
    await expect(page.getByTestId('me-undo')).toBeVisible()
  })

  test('keyboard: Shift+F10 on the focused preview opens the context menu (G11)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, '# Title\n\nbody')
    await page.getByTestId('view-preview').click()
    const article = page.locator('.markdown-preview')
    await expect(article).toBeVisible()
    // The preview <article> is focusable (tabIndex={0}), so Shift+F10 opens its menu.
    await article.focus()
    await page.keyboard.press('Shift+F10')
    await expect(page.getByTestId('preview-copy')).toBeVisible()
  })

  test('sidebar: discarding a draft shows a confirmation and removes it on confirm (PLAN §5-4)', async () => {
    const { electronApp, page } = handle
    await waitForAppReady(page)
    // Auto-answer the native confirm dialog with OK (response 1).
    await installConfirmSpy(electronApp, 1)
    // Create a memory-only draft (no file on disk) via the "+" button.
    await page.getByTestId('new-document-btn').click()
    await expect(page.getByTestId('doc-item')).toBeVisible()
    // Right-click → choose "Discard Draft" (the draft's delete label).
    await page.getByTestId('doc-item').first().click({ button: 'right' })
    await expect(page.getByTestId('side-discard-draft')).toBeVisible()
    await page.getByTestId('side-discard-draft').click()
    // the destructive action is gated behind the in-app confirm dialog
    await expect
      .poll(async () => (await confirmCalls(electronApp)).length, { timeout: 5000 })
      .toBeGreaterThan(0)
    const calls = await confirmCalls(electronApp)
    // The draft path uses the discard phrasing (never "Delete"), per
    expect(calls[0].message).toContain('Discard')
    // Confirming removes the draft from the list.
    await expect(page.getByTestId('doc-item')).toHaveCount(0)
  })

  test('sidebar: cancelling the discard confirmation keeps the draft (PLAN §5-4)', async () => {
    const { electronApp, page } = handle
    await waitForAppReady(page)
    // Auto-answer the native confirm dialog with Cancel (response 0).
    await installConfirmSpy(electronApp, 0)
    await page.getByTestId('new-document-btn').click()
    await expect(page.getByTestId('doc-item')).toBeVisible()
    await page.getByTestId('doc-item').first().click({ button: 'right' })
    await expect(page.getByTestId('side-discard-draft')).toBeVisible()
    await page.getByTestId('side-discard-draft').click()
    await expect
      .poll(async () => (await confirmCalls(electronApp)).length, { timeout: 5000 })
      .toBeGreaterThan(0)
    // Cancelling (response 0) keeps the draft in the list.
    await expect(page.getByTestId('doc-item')).toHaveCount(1)
  })
})

// M3 surfaces — context menus added across the plan's later milestones. These
// exercise the REAL Chromium right-click on each new surface and assert the
// expected items appear (acceptance: every planned right-click menu renders
// its documented items, no crash, no dead/duplicated entry).
test.describe('context menus — M3 surfaces (status bar / search / file-details / resize / folder / welcome)', () => {
  let handle: AppHandle

  test.beforeEach(async () => {
    handle = await launchApp()
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  async function createDocAndType(page: Page, text: string): Promise<void> {
    await page.getByTestId('new-document-btn').click()
    await expect(page.locator('.cm-content')).toBeVisible()
    await page.locator('.cm-content').click()
    await page.keyboard.type(text)
  }

  function scratchDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'markflow-cm3-'))
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(dir, name), body, 'utf-8')
    }
    return dir
  }

  // Open a folder through the real pipeline (resolve -> import -> watch -> activate),
  // mirroring what the "Open Folder" menu does, so the document store is populated
  // and the folder menus have a target.
  async function openFolder(page: Page, folder: string, expectedDocs: number): Promise<void> {
    await page.evaluate(() => (window as any).__uiStore.getState().setActiveFolder(null))
    await page.evaluate(async (f: string) => {
      const { markdownFiles } = await (window as any).api.files.resolvePaths([f])
      const imported = await (window as any).api.documents.importMany(markdownFiles)
      await (window as any).api.documents.setOpenFolder(f)
      const ui = (window as any).__uiStore.getState()
      ui.setActiveFolder(f)
      if (imported.length > 0) ui.setActiveDocumentId(imported[0].id)
    }, folder)
    await expect
      .poll(async () => page.getByTestId('doc-item').count(), { timeout: 15000 })
      .toBe(expectedDocs)
  }

  test('status bar: word-count right-click offers copy word-count / path / filename (PLAN §8)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')
    await page.getByTestId('status-word-count').click({ button: 'right' })
    await expect(page.getByTestId('sb-copy-word-count')).toBeVisible()
    await expect(page.getByTestId('sb-copy-path')).toBeVisible()
    await expect(page.getByTestId('sb-copy-filename')).toBeVisible()
  })

  test('status bar: encoding pill right-click lists encodings + re-detect/copy (PLAN §8)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello')
    await page.getByTestId('status-encoding').click({ button: 'right' })
    await expect(page.getByTestId('sb-redetect-encoding')).toBeVisible()
    await expect(page.getByTestId('sb-copy-encoding')).toBeVisible()
    await expect(page.locator('[data-testid^="sb-encoding-"]').first()).toBeVisible()
  })

  test('status bar: line-ending pill right-click offers CRLF/LF switch + copy (PLAN §8)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    // The EOL pill only renders for a document that has an on-disk line ending
    // (a saved file); a memory-only draft has no `eol`, so open a folder instead.
    const dir = scratchDir({ 'alpha.md': '# Alpha' })
    await openFolder(page, dir, 1)
    await page.getByTestId('status-eol').click({ button: 'right' })
    await expect(page.getByTestId('sb-switch-crlf')).toBeVisible()
    await expect(page.getByTestId('sb-switch-lf')).toBeVisible()
    await expect(page.getByTestId('sb-copy-line-ending')).toBeVisible()
  })

  test('status bar: save region right-click offers save / save-as / reload (PLAN §8)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello')
    await page.getByTestId('status-save-region').click({ button: 'right' })
    await expect(page.getByTestId('sb-save')).toBeVisible()
    await expect(page.getByTestId('sb-save-as')).toBeVisible()
    await expect(page.getByTestId('sb-reload')).toBeVisible()
  })

  test('search palette: right-clicking a result row offers open/copy/title/details (PLAN §9)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const dir = scratchDir({ 'alpha.md': '# Alpha\n\nbody', 'beta.md': '# Beta\n\nbody' })
    await openFolder(page, dir, 2)
    await page.evaluate(() => (window as any).__uiStore.getState().setSearchOpen(true))
    const input = page.getByTestId('search-input')
    await expect(input).toBeVisible()
    await input.fill('alpha')
    const first = page.getByTestId('search-result').first()
    await expect(first).toBeVisible()
    await first.click({ button: 'right' })
    await expect(page.getByTestId('palette-open-document')).toBeVisible()
    await expect(page.getByTestId('palette-copy-title')).toBeVisible()
    await expect(page.getByTestId('palette-copy-result-path')).toBeVisible()
    await expect(page.getByTestId('palette-copy-folder-path')).toBeVisible()
    await expect(page.getByTestId('palette-details')).toBeVisible()
  })

  test('sidebar: resize handle right-click offers reset-width / collapse (PLAN §5.13 / §10)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await page.getByTestId('sidebar-resize-handle').click({ button: 'right' })
    await expect(page.getByTestId('side-reset-sidebar-width')).toBeVisible()
    await expect(page.getByTestId('side-collapse-sidebar')).toBeVisible()
  })

  test('sidebar: welcome state right-click offers new/open-folder/search (PLAN §10 / §5.12)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const welcome = page.getByTestId('sidebar-welcome-state')
    await expect(welcome).toBeVisible()
    await welcome.click({ button: 'right' })
    await expect(page.getByTestId('side-new-document')).toBeVisible()
    await expect(page.getByTestId('side-open-folder')).toBeVisible()
    await expect(page.getByTestId('side-search-documents')).toBeVisible()
  })

  test('sidebar: current-folder bar right-click offers folder operations (PLAN §5.5 / §6.2)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const dir = scratchDir({ 'a.md': '# A', 'b.md': '# B' })
    await openFolder(page, dir, 2)
    const bar = page.getByTestId('current-folder-bar')
    await expect(bar).toBeVisible()
    await bar.click({ button: 'right' })
    await expect(page.getByTestId('side-copy-folder-path')).toBeVisible()
    await expect(page.getByTestId('side-show-in-folder')).toBeVisible()
    await expect(page.getByTestId('side-new-folder-here')).toBeVisible()
    await expect(page.getByTestId('side-rename-folder')).toBeVisible()
    await expect(page.getByTestId('side-delete-folder')).toBeVisible()
    await expect(page.getByTestId('side-close-workspace')).toBeVisible()
  })

  test('file details dialog: right-clicking the path offers copy path/name + show-in-folder (PLAN §10)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const dir = scratchDir({ 'alpha.md': '# Alpha' })
    await openFolder(page, dir, 1)
    await page.getByTestId('file-details-btn').click()
    const pathEl = page.getByTestId('file-details-path')
    await expect(pathEl).toBeVisible()
    await pathEl.click({ button: 'right' })
    await expect(page.getByTestId('fdd-details-copy-path')).toBeVisible()
    await expect(page.getByTestId('fdd-details-copy-filename')).toBeVisible()
    await expect(page.getByTestId('fdd-details-show-in-folder')).toBeVisible()
  })
})

// ── M3 write-operation menus (supplement) ──────────────────────────────
// Menu-driven write ops that were only unit-tested before:
//   - export-html (title menu) writes a standalone .html next to the markdown
//   - rename      (title menu) enters title-edit and renames the document
//   - new-subfolder (folder row) creates a nested folder on disk
//   - go-up       (empty-folder bar) navigates to the parent folder
test.describe('M3 write-operation menus (supplement)', () => {
  let handle: AppHandle
  test.beforeEach(async () => {
    handle = await launchApp()
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  function scratchDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'markflow-cm3-supp-'))
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(dir, name), body, 'utf-8')
    }
    return dir
  }
  async function openFolder(page: Page, folder: string, expectedDocs: number): Promise<void> {
    await page.evaluate(() => (window as any).__uiStore.getState().setActiveFolder(null))
    await page.evaluate(async (f: string) => {
      const { markdownFiles } = await (window as any).api.files.resolvePaths([f])
      const imported = await (window as any).api.documents.importMany(markdownFiles)
      await (window as any).api.documents.setOpenFolder(f)
      const ui = (window as any).__uiStore.getState()
      ui.setActiveFolder(f)
      if (imported.length > 0) ui.setActiveDocumentId(imported[0].id)
    }, folder)
    await expect
      .poll(async () => page.getByTestId('doc-item').count(), { timeout: 15000 })
      .toBe(expectedDocs)
  }

  test('export-html (title menu) writes a standalone HTML file next to the markdown (PLAN §10)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const dir = scratchDir({ 'alpha.md': '# Alpha\n\nHello from e2e.\n' })
    await openFolder(page, dir, 1)
    await page.getByTestId('doc-item').first().click()
    await expect(page.locator('.cm-content')).toBeVisible()
    await page.getByTestId('title-btn').click({ button: 'right' })
    await page.getByTestId('doc-export-html').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Export' })).toBeVisible()
  })

  test('rename (title menu) enters title-edit and renames the document (PLAN §5.3)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const dir = scratchDir({ 'alpha.md': '# Alpha\n' })
    await openFolder(page, dir, 1)
    await page.getByTestId('doc-item').first().click()
    await expect(page.locator('.cm-content')).toBeVisible()
    // doc-rename is disabled unless the document is in edit mode (FileMenuItems gates it on `editable`).
    await page.evaluate(() => (window as any).__uiStore.getState().setEditable(true))
    await page.getByTestId('title-btn').click({ button: 'right' })
    await page.getByTestId('doc-rename').click()
    const input = page.locator('input').first()
    await expect(input).toBeFocused()
    await input.fill('RenamedDoc')
    await input.press('Enter')
    await expect(page.getByTestId('title-btn')).toContainText('RenamedDoc')
  })

  test('new-subfolder (folder row) creates a nested folder on disk (PLAN §6.2)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const dir = mkdtempSync(join(tmpdir(), 'markflow-cm3-supp-'))
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'beta.md'), '# Beta\n', 'utf-8')
    writeFileSync(join(dir, 'alpha.md'), '# Alpha\n', 'utf-8')
    await openFolder(page, dir, 1)
    // Left-click the sub folder row to expand it (so its <ul> children list exists for the inline create row).
    const subRow = page.getByTestId('folder-row').filter({ hasText: 'sub' })
    await subRow.click()
    // Verify expansion: beta.md should now be visible under sub.
    await expect(page.getByTestId('doc-item').filter({ hasText: 'beta' })).toBeVisible()
    // Re-query the row after DOM update to avoid a stale locator.
    const expandedSubRow = page.getByTestId('folder-row').filter({ hasText: 'sub' })
    await expandedSubRow.click({ button: 'right' })
    const newSubItem = page.getByTestId('side-new-subfolder')
    await newSubItem.waitFor({ state: 'visible' })
    await newSubItem.click()
    // The inline create row renders inside the expanded folder's children <ul>.
    const createRow = page.getByTestId('folder-create-row')
    await expect(createRow).toBeVisible()
    const createInput = createRow.locator('input')
    await createInput.fill('nested')
    await createInput.press('Enter')
    await expect.poll(() => existsSync(join(dir, 'sub', 'nested')), { timeout: 15000 }).toBe(true)
  })

  // Folder rename (PLAN §6.2): inline rename must leave exactly ONE folder in the tree
  // (no stale duplicate of the old name lingering until the dirs query refetches) and must
  // preserve the open/closed state — a folder that was expanded stays expanded under the
  // new name. Guards the renderer-side fixes in useRenameFolder (cache rewrite) and
  // Sidebar.submitFolderName (expanded-set re-pointing).
  test('folder rename (inline) shows one folder, no duplicate, keeps it expanded (PLAN §6.2)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const dir = mkdtempSync(join(tmpdir(), 'markflow-cm3-rename-'))
    writeFileSync(join(dir, 'a.md'), '# A\n', 'utf-8')
    mkdirSync(join(dir, 'keep'))
    writeFileSync(join(dir, 'keep', 'b.md'), '# B\n', 'utf-8')
    // b.md lives under the collapsed `keep` folder, so only a.md is visible at first.
    await openFolder(page, dir, 1)
    const keepBtn = page.getByRole('button', { name: /^keep/ })
    // Expand `keep` so its child b.md is visible.
    await keepBtn.click()
    await expect(page.getByTestId('doc-item').filter({ hasText: 'b.md' })).toBeVisible()
    // Right-click -> rename -> inline input -> commit with the new name.
    await keepBtn.click({ button: 'right' })
    await page.getByTestId('side-rename-folder').click()
    const renameInput = page.getByTestId('folder-name-input')
    await expect(renameInput).toBeVisible()
    await renameInput.fill('keep2')
    await renameInput.press('Enter')
    // Exactly one folder remains and it is the new name (no stale duplicate of the old).
    await expect(page.getByTestId('folder-row')).toHaveCount(1)
    await expect(page.getByText('keep2', { exact: true })).toBeVisible()
    await expect(page.getByText('keep', { exact: true })).toHaveCount(0)
    // The renamed folder stays expanded: its child is still visible.
    await expect(page.getByTestId('doc-item').filter({ hasText: 'b.md' })).toBeVisible()
  })

  test('go-up (empty-folder bar) navigates to the parent folder (PLAN §6.2)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const dir = mkdtempSync(join(tmpdir(), 'markflow-cm3-supp-'))
    const sub = join(dir, 'empty-sub')
    mkdirSync(sub)
    await openFolder(page, sub, 0)
    await expect(page.getByTestId('current-folder-bar')).toContainText('empty-sub')
    await page.getByTestId('current-folder-bar').click({ button: 'right' })
    await expect(page.getByTestId('side-go-up')).toBeVisible()
    await page.getByTestId('side-go-up').click()
    await expect(page.getByTestId('current-folder-bar')).toContainText(basename(dir))
  })
})
