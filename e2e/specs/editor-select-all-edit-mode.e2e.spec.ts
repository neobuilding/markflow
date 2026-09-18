// Editor Ctrl+A in EDIT MODE — the exact scenario the user reported
// ("编辑窗格内 Ctrl+A 只会选中当前光标位置之前的内容").
//
// Why this file exists alongside select-all-copy-fidelity.e2e.spec.ts: that spec opens an
// imported document, i.e. READ-ONLY, and gains focus with a click. The bug report came from
// a real editing session (editable=true, focus gained by typing), so this spec pins the
// editable path too: with `EditorView.editable` on, the DOM selection lives in a
// contenteditable, which is precisely the state where the old native `webContents.selectAll()`
// got clamped by CodeMirror into a bogus partial selection.
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test.describe('editor Ctrl+A in edit mode', () => {
  let handle: AppHandle
  let scratch: string

  test.beforeEach(async () => {
    handle = await launchApp()
    scratch = mkdtempSync(join(tmpdir(), 'markflow-editmode-'))
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  async function openDoc(page: Page, content: string): Promise<void> {
    const file = join(scratch, `doc-${Date.now()}.md`)
    writeFileSync(file, content, 'utf-8')
    const id = await page.evaluate(
      (f) => window.api.documents.import(f).then((d: any) => d.id),
      file,
    )
    await page.evaluate((docId) => {
      const w = window as any
      w.__uiStore.getState().setActiveDocumentId(docId)
      w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
    }, id)
    await expect(page.locator('.cm-content')).toBeVisible()
  }

  // The real accelerator path: menu:select-all → selectAllRouter → CodeMirror selectAll.
  async function selectAllViaMenu(): Promise<void> {
    await handle.electronApp.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById('select-all')?.click()
    })
  }

  async function readSelection(page: Page): Promise<{ text: string; inEditor: boolean }> {
    return page.evaluate(() => {
      const s = window.getSelection()
      const node = s?.anchorNode ?? null
      const el = node && node.nodeType === 3 ? node.parentElement : (node as Element | null)
      return { text: s?.toString() ?? '', inEditor: !!el?.closest?.('.cm-content') }
    })
  }

  test('edit mode + typing: the menu select-all selects the whole document', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await openDoc(page, 'alpha line\nbeta line\ngamma line\n')
    // EDIT MODE (the user's state), focus gained by TYPING like a real user.
    await page.evaluate(() => (window as any).__uiStore.getState().setEditable(true))
    await page.locator('.cm-content').click()
    await page.keyboard.type('X')
    await selectAllViaMenu()
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
      .toContain('alpha line')
    const sel = await readSelection(page)
    expect(sel.inEditor).toBe(true)
    expect(sel.text).toContain('gamma line')
  })

  test('edit-only view: the menu select-all selects the whole document', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await openDoc(page, 'alpha line\nbeta line\ngamma line\n')
    await page.getByTestId('view-edit').click()
    await page.locator('.cm-content').click()
    await selectAllViaMenu()
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
      .toContain('alpha line')
    expect((await readSelection(page)).text).toContain('gamma line')
  })

  test('edit mode: CDP Ctrl+A also selects the whole document (CodeMirror keymap path)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await openDoc(page, 'alpha line\nbeta line\ngamma line\n')
    await page.evaluate(() => (window as any).__uiStore.getState().setEditable(true))
    await page.locator('.cm-content').click()
    await page.keyboard.type('X')
    await page.keyboard.press('Control+a')
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
      .toContain('alpha line')
    expect((await readSelection(page)).text).toContain('gamma line')
  })
})
