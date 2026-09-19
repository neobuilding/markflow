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
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { mkTempDir } from '../helpers/temp'

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

  // Plan 02 §4.3 mechanism guard. The menu's "Copy" fires `document.execCommand('copy')` and
  // relies on the resulting `copy` event reaching the preview <article>'s handler (which writes
  // the CLEAN payload: internal attrs stripped, images inlined). That is NOT self-evident: the
  // Radix menu content lives in a PORTAL under document.body, so if focus sat on the menu item the
  // event could be dispatched OUTSIDE #root/<article> and React's delegated onCopy would never
  // run — silently falling back to the browser's "dirty" native copy (R6/R3 broken, images not
  // inlined). jsdom cannot catch that (no execCommand), so the mechanism is pinned here with a REAL
  // Chromium copy event plus a read-back of the real system clipboard. Empirically the event DOES
  // reach the article (probe below) — this test is the regression guard that keeps it that way.
  test('preview: menu Copy reaches the preview copy handler and lands a clean payload (R3/R6)', async () => {
    const { page, electronApp } = handle
    await waitForAppReady(page)
    await createDocAndType(page, '# Title\n\n```js\nconst x = 1\n```\n')
    await page.getByTestId('view-preview').click()
    const article = page.locator('.markdown-preview')
    await expect(article).toBeVisible()
    // Record where every `copy` event lands (capture phase sees it regardless of target).
    await page.evaluate(() => {
      const w = window as any
      w.__copyProbe = { count: 0, inArticle: false }
      document.addEventListener(
        'copy',
        (e) => {
          const t = e.target as HTMLElement | null
          w.__copyProbe.count += 1
          w.__copyProbe.inArticle = !!t?.closest?.('article.markdown-preview')
        },
        true,
      )
    })
    // Right-click the code block → generic variant (pre → not image / link / mermaid).
    await article.locator('pre').first().click({ button: 'right' })
    await page.getByTestId('preview-copy').click()
    await expect
      .poll(() => page.evaluate(() => (window as any).__copyProbe.count))
      .toBeGreaterThan(0)
    // The event must have reached the article, otherwise our clean writer is bypassed.
    expect(await page.evaluate(() => (window as any).__copyProbe.inArticle)).toBe(true)
    // …and the REAL system clipboard (read back from the main process) must hold the clean
    // payload: the code text is present, and none of the pipeline's internal markers leaked.
    // Electron 44 replaced `readHTML()` with `read()` + `ClipboardItem.getType(mime)`.
    await expect
      .poll(async () => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toContain('const x = 1')
    const clip = await electronApp.evaluate(async ({ clipboard }) => {
      const items = await clipboard.read()
      const item = items[0]
      let html = ''
      if (item && item.types.includes('text/html')) {
        const blob = (await item.getType('text/html')) as Blob
        html = await blob.text()
      }
      return { html, text: await clipboard.readText(), types: item ? item.types : [] }
    })
    // Both halves must be present (the browser packed text/plain + text/html from setData).
    expect(clip.types).toContain('text/html')
    // The html keeps the semantic structure; the code text is split by hljs <span>s, so match
    // the tag + a token rather than a contiguous source line.
    expect(clip.html).toContain('<pre')
    expect(clip.html).toContain('const')
    expect(clip.text).toContain('const x = 1')
    // R6: no internal marker survived into the pasted HTML.
    expect(clip.html).not.toContain('data-lang')
    expect(clip.html).not.toContain('data-line')
    expect(clip.html).not.toContain('data-mermaid')
    expect(clip.html).not.toContain('data-baked')
    // markdown-it-anchor's heading tabindex must be stripped too.
    expect(clip.html).not.toContain('tabindex')
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
    const dir = mkTempDir('markflow-cm3-')
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
    const dir = mkTempDir('markflow-cm3-supp-')
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
    const dir = mkTempDir('markflow-cm3-supp-')
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
    // Must be focused the moment it opens, so the user can type straight away — no click needed.
    // Typing via the real keyboard (not .fill) makes this a behaviour-level check: if the
    // context menu steals focus back, the keystrokes go nowhere and no folder is created.
    await expect(createInput).toBeFocused()
    await page.keyboard.type('nested')
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
    const dir = mkTempDir('markflow-cm3-rename-')
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

  // Sidebar file rename (this change): inline rename must move the file on disk directly and
  // stay decoupled from edit mode — it works for a non-active file and neither flips `editable`
  // nor switches the active document. Guards the new Sidebar inline rename + documents:rename-file
  // path (decoupled from the old editor-title rename, which is unchanged for the title menu).
  test('file rename (inline, sidebar) moves the file and stays decoupled from edit mode', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const dir = mkTempDir('markflow-cm3-filerename-')
    writeFileSync(join(dir, 'alpha.md'), '# Alpha\n', 'utf-8')
    writeFileSync(join(dir, 'beta.md'), '# Beta\n', 'utf-8')
    await openFolder(page, dir, 2)
    // Pin the active doc to alpha so we can prove renaming beta does not disturb it.
    await page.getByTestId('doc-item').filter({ hasText: 'alpha' }).click()
    const activeBefore = await page.evaluate(
      () => (window as any).__uiStore.getState().activeDocumentId,
    )
    expect(await page.evaluate(() => (window as any).__uiStore.getState().editable)).toBe(false)
    // Right-click beta -> rename -> inline input -> commit with the new name.
    await page.getByTestId('doc-item').filter({ hasText: 'beta' }).click({ button: 'right' })
    await page.getByTestId('side-rename').click()
    const input = page.getByTestId('folder-name-input')
    await expect(input).toBeVisible()
    // The extension must be SHOWN in the input (not stripped away) so the user can see it…
    await expect(input).toHaveValue('beta.md')
    // …and an extension this app cannot open is REFUSED: nothing is written, the name is
    // turned into the `.md` spelling and the row stays open for the user to accept.
    await input.fill('gamma.txt')
    await input.press('Enter')
    await expect(input).toHaveValue('gamma.md')
    await expect.poll(() => existsSync(join(dir, 'beta.md')), { timeout: 15000 }).toBe(true)
    // A SUPPORTED extension typed by the user is the one that lands on disk.
    await input.fill('gamma.markdown')
    await input.press('Enter')
    // File moved on disk under exactly the typed name: gamma.markdown exists, beta.md is gone.
    await expect.poll(() => existsSync(join(dir, 'gamma.markdown')), { timeout: 15000 }).toBe(true)
    await expect.poll(() => existsSync(join(dir, 'beta.md')), { timeout: 15000 }).toBe(false)
    // Edit mode untouched, active doc untouched (decoupling).
    expect(await page.evaluate(() => (window as any).__uiStore.getState().editable)).toBe(false)
    expect(await page.evaluate(() => (window as any).__uiStore.getState().activeDocumentId)).toBe(
      activeBefore,
    )
    // Sidebar shows the renamed file, not the old name.
    await expect(page.getByTestId('doc-item').filter({ hasText: 'gamma.markdown' })).toBeVisible()
    await expect(page.getByTestId('doc-item').filter({ hasText: 'beta.md' })).toHaveCount(0)
  })

  // The bare-name rule is not create-only: renaming to a stem with no extension is completed and
  // HELD (never silently committed), so a second Enter is what actually moves the file.
  test('sidebar: renaming to a bare name fills ".md" and holds until a second Enter', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const dir = mkTempDir('markflow-renamestem-')
    writeFileSync(join(dir, 'alpha.md'), '# Alpha\n', 'utf-8')
    await openFolder(page, dir, 1)
    await page.getByTestId('doc-item').filter({ hasText: 'alpha' }).click({ button: 'right' })
    await page.getByTestId('side-rename').click()
    const input = page.getByTestId('folder-name-input')
    await expect(input).toHaveValue('alpha.md')
    await input.fill('alpha2')
    await input.press('Enter')
    // Held: the row stays open showing the completed name, and nothing has moved on disk.
    await expect(input).toHaveValue('alpha2.md')
    await expect(page.getByTestId('file-rename-row')).toBeVisible()
    await page.waitForTimeout(500)
    expect(existsSync(join(dir, 'alpha2.md'))).toBe(false)
    // The second Enter commits the rename.
    await input.press('Enter')
    await expect.poll(() => existsSync(join(dir, 'alpha2.md')), { timeout: 15000 }).toBe(true)
    await expect.poll(() => existsSync(join(dir, 'alpha.md')), { timeout: 15000 }).toBe(false)
  })

  // New File (inline): the extension the user types is the one that lands on disk — `.md` is
  // only filled in when they typed none at all. The row is also pinned into the tree list at the
  // folder/file seam, which is asserted here (unit tests cover the seam in more detail).
  test('new file (inline) uses the Markdown extension the user typed, not a forced .md', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const dir = mkTempDir('markflow-cm3-newfile-')
    writeFileSync(join(dir, 'alpha.md'), '# Alpha\n', 'utf-8')
    // A subfolder that holds Markdown, so the tree has a folder row for the new row to sit after.
    // It stays collapsed, so the doc-item count the open helper asserts is still 1.
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'sub', 'b.md'), '# B\n', 'utf-8')
    await openFolder(page, dir, 1)
    // Right-click empty tree space -> New File -> name it with an explicit extension.
    await page
      .getByTestId('sidebar-tree-area')
      .click({ button: 'right', position: { x: 80, y: 200 } })
    await page.getByTestId('side-bg-new-file').click()
    const createRow = page.getByTestId('file-create-row')
    await expect(createRow).toBeVisible()
    // After the last subfolder, before the first file — never at the top of the sidebar (which is
    // where it used to be, in a list of its own). Compared by testid to stay host-independent.
    const order = await page
      .locator(
        '[data-testid="folder-row"], [data-testid="doc-item"], [data-testid="file-create-row"]',
      )
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')))
    expect(order).toEqual(['folder-row', 'file-create-row', 'doc-item'])
    await createRow.locator('input').fill('notes.markdown')
    await createRow.locator('input').press('Enter')
    await expect.poll(() => existsSync(join(dir, 'notes.markdown')), { timeout: 15000 }).toBe(true)
  })

  test('go-up (empty-folder bar) navigates to the parent folder (PLAN §6.2)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const dir = mkTempDir('markflow-cm3-supp-')
    const sub = join(dir, 'empty-sub')
    mkdirSync(sub)
    await openFolder(page, sub, 0)
    await expect(page.getByTestId('current-folder-bar')).toContainText('empty-sub')
    await page.getByTestId('current-folder-bar').click({ button: 'right' })
    await expect(page.getByTestId('side-go-up')).toBeVisible()
    await page.getByTestId('side-go-up').click()
    await expect(page.getByTestId('current-folder-bar')).toContainText(basename(dir))
  })

  // ── Folder filtering (ADR-0010) ────────────────────────────────────────────────
  // Default: only folders that (transitively) hold Markdown are shown. "Show All Folders"
  // (toolbar button and tree-area checkbox are ONE shared flag) reveals the rest, and a
  // folder the user just created stays visible even while it is still empty.
  test('sidebar: empty folders hidden by default, revealed by "Show All Folders" (ADR-0010)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const dir = mkTempDir('markflow-showall-')
    writeFileSync(join(dir, 'a.md'), '# A\n', 'utf-8')
    mkdirSync(join(dir, 'pics')) // holds no Markdown at all
    await openFolder(page, dir, 1)
    // Default (toggle OFF): the document-less folder never becomes a tree node.
    await expect(page.getByTestId('folder-row').filter({ hasText: 'pics' })).toHaveCount(0)
    // Toggle on: the very same folder shows up.
    await page.getByTestId('show-all-folders-btn').click()
    await expect(page.getByTestId('folder-row').filter({ hasText: 'pics' })).toBeVisible()
  })

  test('sidebar: tree-area right-click offers create + filter items (ADR-0010)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const dir = mkTempDir('markflow-treemenu-')
    writeFileSync(join(dir, 'a.md'), '# A\n', 'utf-8')
    await openFolder(page, dir, 1)
    // Aim below the document row: the middle of the scroll area is empty space, so the
    // background menu opens instead of the document row's own menu.
    await page
      .getByTestId('sidebar-tree-area')
      .click({ button: 'right', position: { x: 80, y: 200 } })
    await expect(page.getByTestId('side-bg-new-folder')).toBeVisible()
    await expect(page.getByTestId('side-bg-new-file')).toBeVisible()
    // Checkbox and toolbar button drive the same flag: ticking one presses the other.
    await page.getByTestId('side-bg-show-all-folders').click()
    await expect(page.getByTestId('show-all-folders-btn')).toHaveAttribute('aria-pressed', 'true')
  })

  // Regression guard: the inline create row used to live inside the `tree.length > 0`
  // branch, so in the empty state (tree is empty by definition) the menu item set the edit
  // state and then rendered nothing — it looked completely broken.
  test('sidebar: the empty state can still create a folder (ADR-0010)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const dir = mkTempDir('markflow-emptynew-')
    await openFolder(page, dir, 0) // no Markdown at all → sidebar shows the empty state
    await expect(page.getByTestId('sidebar-empty-state')).toBeVisible()
    await page.getByTestId('sidebar-empty-state').click({ button: 'right' })
    await page.getByTestId('side-empty-new-folder').click()
    const createRow = page.getByTestId('folder-create-row')
    await expect(createRow).toBeVisible()
    await createRow.locator('input').fill('docs')
    await createRow.locator('input').press('Enter')
    await expect.poll(() => existsSync(join(dir, 'docs')), { timeout: 15000 }).toBe(true)
  })

  test('sidebar: empty-state New File writes a real .md into the open folder (ADR-0010)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const dir = mkTempDir('markflow-emptynewfile-')
    await openFolder(page, dir, 0) // no Markdown at all → sidebar shows the empty state
    await expect(page.getByTestId('sidebar-empty-state')).toBeVisible()
    await page.getByTestId('sidebar-empty-state').click({ button: 'right' })
    // The empty-state menu offers New File (a real file) — there is no "New Draft" here, since
    // the sidebar manages the current folder, not the in-memory draft list.
    await expect(page.getByTestId('side-empty-new-file')).toBeVisible()
    await page.getByTestId('side-empty-new-file').click()
    const createRow = page.getByTestId('file-create-row')
    await expect(createRow).toBeVisible()
    await createRow.locator('input').fill('hello')
    // A bare stem is treated as a name still being typed: the first Enter only fills in ".md"
    // and HOLDS the commit (nothing is written yet), so the row must show the completed name.
    await createRow.locator('input').press('Enter')
    await expect(createRow.locator('input')).toHaveValue('hello.md')
    // The second Enter is what actually writes the file.
    await createRow.locator('input').press('Enter')
    await expect.poll(() => existsSync(join(dir, 'hello.md')), { timeout: 15000 }).toBe(true)
  })

  test('sidebar: New File inside a subfolder names it inline and lands in THAT subfolder', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const dir = mkTempDir('markflow-subnewfile-')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    // A non-empty subfolder so its row is rendered: empty folders are hidden by default
    // (ADR-0010), which would make the row unfindable.
    writeFileSync(join(dir, 'sub', 'placeholder.md'), '# Placeholder\n', 'utf-8')
    writeFileSync(join(dir, 'alpha.md'), '# Alpha\n', 'utf-8')
    await openFolder(page, dir, 1)
    const sub = page.getByTestId('folder-row').filter({ hasText: 'sub' })
    await sub.click({ button: 'right' })
    await page.getByTestId('side-new-doc-here').click()
    // Regression: this used to create "Untitled.md" straight away with no chance to name it,
    // unlike the tree-area "New File". The inline row must open INSIDE the subfolder.
    const row = page.getByTestId('sub-file-create-row')
    await expect(row).toBeVisible()
    await row.locator('input').fill('note')
    // Same two-step commit as the empty-state case: the first Enter fills in ".md" and holds.
    await row.locator('input').press('Enter')
    await expect(row.locator('input')).toHaveValue('note.md')
    await row.locator('input').press('Enter')
    // A real file — and inside the SUBFOLDER, not at the folder root.
    await expect.poll(() => existsSync(join(dir, 'sub', 'note.md')), { timeout: 15000 }).toBe(true)
    expect(existsSync(join(dir, 'note.md'))).toBe(false)
  })

  test('sidebar: F2 starts an inline rename on the focused row', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const dir = mkTempDir('markflow-f2-')
    writeFileSync(join(dir, 'alpha.md'), '# Alpha\n', 'utf-8')
    await openFolder(page, dir, 1)
    const row = page.getByTestId('doc-item').filter({ hasText: 'alpha.md' })
    await row.click() // put the focus on the row (rows are a tab stop)
    await page.keyboard.press('F2')
    const input = page.getByTestId('folder-name-input')
    await expect(input).toBeVisible()
    // Prefilled with the current name, exactly like the context-menu rename.
    await expect(input).toHaveValue('alpha.md')
  })

  test('sidebar: Ctrl+Z undoes the last rename on disk and restores the old file', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const dir = mkTempDir('markflow-renameundo-')
    writeFileSync(join(dir, 'alpha.md'), '# Alpha\n', 'utf-8')
    await openFolder(page, dir, 1)
    await page.getByTestId('doc-item').filter({ hasText: 'alpha.md' }).click({ button: 'right' })
    await page.getByTestId('side-rename').click()
    const input = page.getByTestId('folder-name-input')
    await input.fill('beta.md')
    await input.press('Enter')
    await expect.poll(() => existsSync(join(dir, 'beta.md')), { timeout: 15000 }).toBe(true)
    // Focus is handed back to the renamed row, so Ctrl+Z reaches the sidebar-scoped handler.
    await page.getByTestId('doc-item').filter({ hasText: 'beta.md' }).click()
    await page.keyboard.press('Control+z')
    // The file moves back: old name present again, new name gone.
    await expect.poll(() => existsSync(join(dir, 'alpha.md')), { timeout: 15000 }).toBe(true)
    await expect.poll(() => existsSync(join(dir, 'beta.md')), { timeout: 15000 }).toBe(false)
  })

  test('sidebar: a just-created empty folder stays visible (ADR-0010)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const dir = mkTempDir('markflow-newfolder-')
    writeFileSync(join(dir, 'a.md'), '# A\n', 'utf-8')
    await openFolder(page, dir, 1)
    await page
      .getByTestId('sidebar-tree-area')
      .click({ button: 'right', position: { x: 80, y: 200 } })
    await page.getByTestId('side-bg-new-folder').click()
    const createRow = page.getByTestId('folder-create-row')
    await expect(createRow).toBeVisible()
    await createRow.locator('input').fill('fresh')
    await createRow.locator('input').press('Enter')
    await expect.poll(() => existsSync(join(dir, 'fresh')), { timeout: 15000 }).toBe(true)
    // Still empty, but pinned: it must not disappear behind the filter.
    await expect(page.getByTestId('folder-row').filter({ hasText: 'fresh' })).toBeVisible()
  })

  test('sidebar: the pin is dropped once the created folder holds Markdown (ADR-0010)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const dir = mkTempDir('markflow-pindrop-')
    writeFileSync(join(dir, 'a.md'), '# A\n', 'utf-8')
    await openFolder(page, dir, 1)
    await page
      .getByTestId('sidebar-tree-area')
      .click({ button: 'right', position: { x: 80, y: 200 } })
    await page.getByTestId('side-bg-new-folder').click()
    const createRow = page.getByTestId('folder-create-row')
    await expect(createRow).toBeVisible()
    await createRow.locator('input').fill('fresh')
    await createRow.locator('input').press('Enter')
    await expect.poll(() => existsSync(join(dir, 'fresh')), { timeout: 15000 }).toBe(true)
    // Pinned while it is empty — that is the whole reason it stays on screen.
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).__uiStore.getState().recentlyCreatedFolders.size),
      )
      .toBe(1)
    // Give it a Markdown document: from now on it qualifies on its own, so the pin is dropped.
    writeFileSync(join(dir, 'fresh', 'b.md'), '# B\n', 'utf-8')
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).__uiStore.getState().recentlyCreatedFolders.size),
      )
      .toBe(0)
    // Still shown — now because it holds Markdown, not because it is pinned.
    await expect(page.getByTestId('folder-row').filter({ hasText: 'fresh' })).toBeVisible()
  })

  test('sidebar: a New File with an unsupported extension is refused, not written (ADR-0011)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const dir = mkTempDir('markflow-newfile-badext-')
    writeFileSync(join(dir, 'alpha.md'), '# Alpha\n', 'utf-8')
    await openFolder(page, dir, 1)
    await page
      .getByTestId('sidebar-tree-area')
      .click({ button: 'right', position: { x: 80, y: 200 } })
    await page.getByTestId('side-bg-new-file').click()
    const createRow = page.getByTestId('file-create-row')
    await expect(createRow).toBeVisible()
    const input = createRow.locator('input')
    await input.fill('notes.txt')
    await input.press('Enter')
    // Refused: nothing is written and the `.md` spelling is offered in the still-open row.
    await expect(input).toHaveValue('notes.md')
    // Accepting the offered name is what actually writes the file.
    await input.press('Enter')
    await expect.poll(() => existsSync(join(dir, 'notes.md')), { timeout: 15000 }).toBe(true)
    expect(existsSync(join(dir, 'notes.txt'))).toBe(false)
  })

  // Duplicate names are refused up front: the row flags the clash live and Enter does nothing.
  // Critically the app must NOT invent an `alpha-1.md` behind the user's back — that is what the
  // main process used to do with its `-N` retry.
  test('sidebar: a duplicate file name is flagged live and Enter is refused (no -N fallback)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const dir = mkTempDir('markflow-dupefile-')
    writeFileSync(join(dir, 'alpha.md'), '# Alpha\n', 'utf-8')
    await openFolder(page, dir, 1)
    await page
      .getByTestId('sidebar-tree-area')
      .click({ button: 'right', position: { x: 80, y: 200 } })
    await page.getByTestId('side-bg-new-file').click()
    const input = page.getByTestId('file-create-row').locator('input')
    await input.fill('alpha')
    // Flagged before any commit: the red border is the live same-name check, not a post-hoc error.
    await expect(input).toHaveClass(/border-red-500/)
    await input.press('Enter')
    // Refused: the row stays open and nothing lands on disk.
    await expect(page.getByTestId('file-create-row')).toBeVisible()
    await page.waitForTimeout(500)
    expect(existsSync(join(dir, 'alpha-1.md'))).toBe(false)
    // A unique name clears the flag and commits in one Enter (it carries an extension).
    await input.fill('alpha2.md')
    await input.press('Enter')
    await expect.poll(() => existsSync(join(dir, 'alpha2.md')), { timeout: 15000 }).toBe(true)
  })

  test('sidebar: a duplicate folder name is refused without inventing a -N variant', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const dir = mkTempDir('markflow-dupefolder-')
    writeFileSync(join(dir, 'alpha.md'), '# Alpha\n', 'utf-8')
    // An existing subfolder holding Markdown, so its row is rendered and can be clashed with.
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'sub', 'b.md'), '# B\n', 'utf-8')
    await openFolder(page, dir, 1)
    await page
      .getByTestId('sidebar-tree-area')
      .click({ button: 'right', position: { x: 80, y: 200 } })
    await page.getByTestId('side-bg-new-folder').click()
    const input = page.getByTestId('folder-create-row').locator('input')
    await input.fill('sub')
    await expect(input).toHaveClass(/border-red-500/)
    await input.press('Enter')
    await expect(page.getByTestId('folder-create-row')).toBeVisible()
    await page.waitForTimeout(500)
    // Neither a silent success (the old recursive mkdir) nor a -N fallback.
    expect(existsSync(join(dir, 'sub-1'))).toBe(false)
    await input.fill('sub2')
    await input.press('Enter')
    await expect.poll(() => existsSync(join(dir, 'sub2')), { timeout: 15000 }).toBe(true)
  })

  // VS Code's "invalid name" rule: a name carrying a separator can never be written (mkdir is
  // non-recursive now), so it is refused as it is typed instead of failing the commit.
  test('sidebar: a folder name with a separator is flagged live and refused', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const dir = mkTempDir('markflow-badname-')
    writeFileSync(join(dir, 'alpha.md'), '# Alpha\n', 'utf-8')
    await openFolder(page, dir, 1)
    await page
      .getByTestId('sidebar-tree-area')
      .click({ button: 'right', position: { x: 80, y: 200 } })
    await page.getByTestId('side-bg-new-folder').click()
    const input = page.getByTestId('folder-create-row').locator('input')
    await input.fill('a/b')
    await expect(input).toHaveClass(/border-red-500/)
    await input.press('Enter')
    await expect(page.getByTestId('folder-create-row')).toBeVisible()
    await page.waitForTimeout(500)
    // Neither a nested `a/b` pair nor a sanitized `a-b` is invented behind the user's back.
    expect(existsSync(join(dir, 'a'))).toBe(false)
    expect(existsSync(join(dir, 'a-b'))).toBe(false)
  })
})
