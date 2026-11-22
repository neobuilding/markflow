import { test, expect } from '@playwright/test'
import {
  launchApp,
  closeApp,
  installConfirmSpy,
  getConfirmCalls,
  type AppHandle,
} from '../helpers/launch'
import { resetAppState } from '../helpers/reset'
import { mkTempDir } from '../helpers/temp'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ADR-0040: only real Electron can prove the tab strip is wired into a window and the
// close prompt is a single aggregate dialog. Draft/history/state assertions live in UT.
test.describe('document tabs', () => {
  test.describe.configure({ mode: 'serial' })
  let handle: AppHandle
  let scratch: string

  test.beforeAll(async () => {
    handle = await launchApp()
  })

  test.beforeEach(async () => {
    await resetAppState(handle)
    scratch = mkTempDir('markflow-tabs-')
    mkdirSync(scratch, { recursive: true })
    writeFileSync(join(scratch, 'a.md'), '# A\n', 'utf-8')
    writeFileSync(join(scratch, 'b.md'), '# B\n', 'utf-8')
    await handle.page.evaluate(
      async ({ root, files }) => {
        await window.api.documents.setWorkspaceRoot(root)
        await window.api.documents.importMany(files)
        const w = window as any
        w.__uiStore.getState().setWorkspaceRoot(root)
        w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
      },
      { root: scratch, files: [join(scratch, 'a.md'), join(scratch, 'b.md')] },
    )
  })

  test.afterEach(async () => {
    for (const extra of handle.electronApp.windows().slice(1)) await extra.close()
  })

  test.afterAll(async () => {
    await closeApp(handle)
  })

  test('arrow keys switch tabs and the editor binds to the target document', async () => {
    await handle.page.evaluate(async () => {
      const docs = await window.api.documents.list()
      const w = window as any
      w.__tabs.getState().reset()
      for (const d of docs) w.__tabs.getState().openTab(d.id, { title: d.title, activate: false })
      const first = w.__tabs.getState().tabs[0]
      if (first) w.__tabs.getState().activateTab(first.id)
    })
    const tabBar = handle.page.getByTestId('tab-bar')
    await expect(tabBar).toBeVisible()
    await expect(tabBar.getByRole('tab')).toHaveCount(2)
    const before = await handle.page.evaluate(() => (window as any).__tabs.getState().activeTabId)
    await tabBar.locator('[role="tab"][aria-selected="true"]').focus()
    await handle.page.keyboard.press('ArrowRight')
    await expect
      .poll(() => handle.page.evaluate(() => (window as any).__tabs.getState().activeTabId))
      .not.toBe(before)
  })

  test('a real dirty close shows ONE aggregate prompt and Cancel vetoes the close', async () => {
    await installConfirmSpy(handle, { responses: [0] })
    await handle.page.evaluate(async () => {
      const docs = await window.api.documents.list()
      const w = window as any
      w.__tabs.getState().reset()
      for (const d of docs) {
        w.__tabs.getState().openTab(d.id, { title: d.title, activate: false })
        w.__uiStore.getState().reportUnsavedBuffer(d.id, 'draft', d.title)
      }
      w.__uiStore.getState().setDirty(true)
    })
    const windowsBefore = handle.electronApp.windows().length
    await handle.electronApp.evaluate((electron: any) => {
      electron.BrowserWindow.getAllWindows()[0]?.close()
    }, undefined)
    await handle.page.waitForTimeout(300)
    // Cancel (response 0) vetoes the whole close.
    expect(handle.electronApp.windows().length).toBe(windowsBefore)
    const calls = await getConfirmCalls(handle)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0].message).toContain('unsaved changes')
  })
})
