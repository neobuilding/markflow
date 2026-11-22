import { test, expect } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, type AppHandle } from '../helpers/launch'
import { resetAppState } from '../helpers/reset'
import { mkTempDir } from '../helpers/temp'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ADR-0040: a real cross-window move routes app:tab-accept to the owner window and
// removes the tab from the source only after the ACK. Payload/routing details are
// unit-tested (ipc/tabs.test.ts); this spec proves the real two-window IPC path.
test.describe('tab drag cross-window', () => {
  test.describe.configure({ mode: 'serial' })
  let handle: AppHandle
  let scratch: string

  test.beforeAll(async () => {
    handle = await launchApp()
  })

  test.beforeEach(async () => {
    await resetAppState(handle)
    scratch = mkTempDir('markflow-cross-')
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

  test('move-to-window delivers the tab to the target window', async () => {
    // Open a second window rooted at the same scratch folder.
    const opened = handle.electronApp.waitForEvent('window')
    await handle.page.evaluate(
      (file) => window.api.app.openInNewWindow(file),
      join(scratch, 'b.md'),
    )
    const second = await opened
    await waitForAppReady(second)

    const windows = await handle.page.evaluate(() => window.api.tabs.listWindows())
    expect(windows.length).toBeGreaterThan(0)
    const targetId = windows[0].id

    const tabId = await handle.page.evaluate(async () => {
      const docs = await window.api.documents.list()
      const w = window as any
      w.__tabs.getState().reset()
      const id = w.__tabs.getState().openTab(docs[0].id, { title: docs[0].title })
      w.__tabs.getState().activateTab(id)
      return id
    })

    const result = await handle.page.evaluate(
      async ({ tabId, targetWindowId }) => {
        const w = window as any
        const tab = w.__tabs.getState().tabs.find((t: any) => t.id === tabId)
        const doc = await window.api.documents.get(tab.documentId)
        if (!doc) return 'no-session' as const
        const handoff = {
          tabId: tab.id,
          documentId: doc.id,
          filePath: doc.filePath,
          content: null,
          title: doc.title,
          external: false,
          isNewUnsaved: false,
          eol: '\n' as const,
          history: [],
          cursor: -1,
        }
        const { token } = await window.api.tabs.beginDrag(handoff)
        return window.api.tabs.moveToWindow(token, targetWindowId)
      },
      { tabId, targetWindowId: targetId },
    )
    expect(result).toBe('consumed')
    await expect
      .poll(async () => {
        const tabs = await second.evaluate(() => (window as any).__tabs.getState().tabs)
        return tabs.some((t: any) => t.id === tabId)
      })
      .toBe(true)
  })
})
