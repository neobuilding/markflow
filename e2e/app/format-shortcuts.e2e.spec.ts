import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mkTempDir } from '../helpers/temp'

// The editor's formatting shortcuts (ADR-0032) — the cluster ADR-0031 started with ⌘B.
//
// These bindings are RENDERER-ONLY (no native accelerator), so Playwright's `keyboard.press`
// drives them directly, exactly like the ⌘B test in `sidebar-shortcuts.e2e.spec.ts`.
//
// What is worth asserting in the real app and NOT in a unit test:
//   - the keys reach the editor at all (a native menu item holding the same combination would
//     swallow the key before the renderer sees it);
//   - the CodeMirror default keymap does NOT also act on them — ⌘⇧K is `deleteLine` there, and
//     a bubble-phase listener would delete the line AND open the palette;
//   - the relocated app commands (Quick Open → ⌘⇧K, File Details → ⌘⇧I) answer to their NEW
//     keys and no longer to the old ones.
//
// The modifier follows the platform, exactly like the renderer's own handler does
// (App.tsx: `isMac ? e.metaKey : e.ctrlKey`).
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

test.describe('format shortcuts (ADR-0032)', () => {
  let handle: AppHandle
  let scratch: string

  test.beforeEach(async () => {
    handle = await launchApp()
    scratch = mkTempDir('markflow-e2e-format-shortcuts-')
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  // Clear the editor and type one word, then select it — the state every formatting shortcut acts
  // on. A new draft starts with a "# Untitled" heading, so the content is cleared first; otherwise
  // the assertion would see the default title as well.
  async function replaceContent(page: Page, word: string): Promise<void> {
    const editor = page.locator('.cm-content')
    await editor.click()
    await page.keyboard.press(`${mod}+A`)
    await page.keyboard.press('Delete')
    await page.keyboard.type(word)
    await expect(editor).toContainText(word)
    await page.keyboard.press(`${mod}+A`)
  }

  // A new draft with one word in it, editor focused and the word selected.
  async function selectWord(page: Page, word: string): Promise<void> {
    await page.getByTestId('new-document-btn').click()
    await expect(page.locator('.cm-content')).toBeVisible()
    await replaceContent(page, word)
  }

  // Empty the editor with the caret COLLAPSED (no selection) — the state that exercises the
  // no-placeholder path: with nothing selected, the markers are inserted with the caret parked
  // between them (the mainstream Markdown-editor behaviour), never a literal 'text' placeholder.
  async function clearNoSelection(page: Page): Promise<void> {
    const editor = page.locator('.cm-content')
    await editor.click()
    await page.keyboard.press(`${mod}+A`)
    await page.keyboard.press('Delete')
  }

  // Open a real document on disk and activate it through the store — needed whenever a command
  // is gated on "a file is open" (the native menu ships those items disabled).
  async function openDocument(page: Page, relPath: string, content: string): Promise<void> {
    const abs = join(scratch, relPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf-8')
    const id = await page.evaluate(
      (f) =>
        (window as any).api.documents.import(f).then((d: any) => {
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
  }

  test('⌘I applies Italic to the selection', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await selectWord(page, 'hello')
    await page.keyboard.press(`${mod}+I`)
    await expect(page.locator('.cm-content')).toContainText('_hello_')
  })

  test('⌘K inserts a Link around the selection', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await selectWord(page, 'hello')
    await page.keyboard.press(`${mod}+K`)
    await expect(page.locator('.cm-content')).toContainText('[hello](url)')
  })

  test('⌘E wraps the selection in inline code', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await selectWord(page, 'hello')
    await page.keyboard.press(`${mod}+E`)
    await expect(page.locator('.cm-content')).toContainText('`hello`')
  })

  test('⌘⇧L turns the selection into a bullet list', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await selectWord(page, 'hello')
    await page.keyboard.press(`${mod}+Shift+L`)
    await expect(page.locator('.cm-content')).toContainText('- hello')
  })

  test('⌘⇧T turns the selection into a task-list item', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await selectWord(page, 'hello')
    await page.keyboard.press(`${mod}+Shift+T`)
    await expect(page.locator('.cm-content')).toContainText('- [ ] hello')
  })

  test('⌘1..⌘6 apply the heading levels', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await selectWord(page, 'hello')
    await page.keyboard.press(`${mod}+1`)
    await expect(page.locator('.cm-content')).toContainText('# hello')

    // The heading shortcut PREPENDS a marker — it does not convert an existing level (the
    // toolbar's H1 button behaves the same), so the next level is checked on fresh content.
    await replaceContent(page, 'second')
    await page.keyboard.press(`${mod}+3`)
    await expect(page.locator('.cm-content')).toContainText('### second')
  })

  // No-selection formatting must park the caret between the markers (the mainstream behaviour) and
  // must NOT inject a literal 'text' placeholder. This is the real-app regression guard for
  // ADR-0032's "the toolbar/shortcut and the right-click menu share ONE insert path" — it catches
  // any future drift back to `**text**`.
  test('⌘B with no selection parks the caret between markers (no text placeholder)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await page.getByTestId('new-document-btn').click()
    await clearNoSelection(page)
    await page.keyboard.press(`${mod}+B`)
    await expect(page.locator('.cm-content')).toContainText('**')
    await expect(page.locator('.cm-content')).not.toContainText('text')
  })

  // ⌘K is the editor's Link action now — the palette must NOT answer to it any more.
  test('plain ⌘K inserts a link instead of opening the Quick Open palette', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await selectWord(page, 'hello')
    await page.keyboard.press(`${mod}+K`)
    await expect(page.getByTestId('search-input')).toHaveCount(0)
    await expect(page.locator('.cm-content')).toContainText('[hello](url)')
  })

  // The Quick Open chord MOVED to ⌘⇧K. CodeMirror's own default keymap binds ⌘⇧K to
  // `deleteLine`, so this is the regression guard for the capture-phase claim: without it the
  // keystroke would delete the line AND open the palette.
  test('⌘⇧K opens Quick Open and leaves the document untouched', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await selectWord(page, 'hello')

    await page.keyboard.press(`${mod}+Shift+K`)
    await expect(page.getByTestId('search-input')).toBeVisible()
    // The line was NOT deleted by CodeMirror's `deleteLine` binding.
    await expect(page.locator('.cm-content')).toContainText('hello')
  })

  // File Details moved to ⌘⇧I. A native accelerator is consumed by the OS menu and never
  // reaches the page, so the binding is asserted on the MENU ITEM and the command is exercised by
  // activating that item — exactly what the OS does on a real keypress.
  test('File Details owns ⌘⇧I and nothing claims ⌘I', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await openDocument(page, 'doc.md', '# Title\n\nbody\n')
    await expect(page.locator('.cm-content')).toBeVisible()
    // The item is disabled while no file is open, so wait for the main process to enable it.
    await expect
      .poll(() =>
        handle.electronApp.evaluate(({ Menu }) => {
          const item = Menu.getApplicationMenu()?.getMenuItemById('file-details')
          return item?.enabled === true
        }),
      )
      .toBe(true)

    const binding = await handle.electronApp.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu()
      const all: { id: string; accelerator: string }[] = []
      const walk = (items: any[]) => {
        for (const item of items) {
          all.push({ id: item.id ?? '', accelerator: item.accelerator ?? '' })
          if (item.submenu) walk(item.submenu.items)
        }
      }
      walk(menu?.items ?? [])
      return {
        fileDetails: menu?.getMenuItemById('file-details')?.accelerator ?? '',
        plainIOwners: all.filter((i) => i.accelerator === 'CmdOrCtrl+I'),
        plainKOwners: all.filter((i) => i.accelerator === 'CmdOrCtrl+K'),
      }
    })
    expect(binding.fileDetails).toBe('CmdOrCtrl+Shift+I')
    // ⌘I is the editor's Italic action (renderer-only) and ⌘K its Link action — a native item
    // holding either would swallow the key before the renderer ever sees it.
    expect(binding.plainIOwners).toHaveLength(0)
    expect(binding.plainKOwners).toHaveLength(0)

    await handle.electronApp.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById('file-details')?.click()
    })
    await expect(page.getByTestId('file-details-path')).toBeVisible()
  })
})
