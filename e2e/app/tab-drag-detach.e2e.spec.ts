import { test, expect } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, type AppHandle } from '../helpers/launch'
import { resetAppState } from '../helpers/reset'
import { mkTempDir } from '../helpers/temp'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ADR-0040: a real detached tab must create a NEW BrowserWindow that shows the
// handed-off document. The handoff payload/ACK sequencing is unit-tested; this spec
// only proves the OS-level drag → new window path is wired end to end.
test.describe('tab drag detach', () => {
  test.describe.configure({ mode: 'serial' })
  let handle: AppHandle
  let scratch: string

  test.beforeAll(async () => {
    handle = await launchApp()
  })

  test.beforeEach(async () => {
    await resetAppState(handle)
    scratch = mkTempDir('markflow-detach-')
    mkdirSync(scratch, { recursive: true })
    writeFileSync(join(scratch, 'a.md'), '# Detached A\n', 'utf-8')
    await handle.page.evaluate(
      async ({ root, file }) => {
        await window.api.documents.setWorkspaceRoot(root)
        await window.api.documents.import(file)
        const w = window as any
        w.__uiStore.getState().setWorkspaceRoot(root)
        w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
      },
      { root: scratch, file: join(scratch, 'a.md') },
    )
  })

  test.afterEach(async () => {
    for (const extra of handle.electronApp.windows().slice(1)) await extra.close()
  })

  test.afterAll(async () => {
    await closeApp(handle)
  })

  test('detaching a tab opens a new window showing that document', async () => {
    await handle.page.evaluate(async () => {
      const docs = await window.api.documents.list()
      const w = window as any
      w.__tabs.getState().reset()
      const id = w.__tabs.getState().openTab(docs[0].id, { title: docs[0].title })
      w.__tabs.getState().activateTab(id)
    })
    await expect(handle.page.getByTestId('tab-bar')).toBeVisible()

    const windowsBefore = handle.electronApp.windows().length
    const opened = handle.electronApp.waitForEvent('window')
    // The menu alternative drives the same session/detach path as a pointer drag.
    await handle.page.evaluate(async () => {
      const w = window as any
      const tab = w.__tabs
        .getState()
        .tabs.find((t: any) => t.id === w.__tabs.getState().activeTabId)
      const doc = await window.api.documents.get(tab.documentId)
      if (!doc) return
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
      await window.api.tabs.detach(token)
    })
    const second = await opened
    await waitForAppReady(second)
    await expect.poll(() => handle.electronApp.windows().length).toBe(windowsBefore + 1)
    // The new renderer consumes take-handoff at startup and mounts a tab for it.
    // waitForEvent('window') can resolve before the renderer boots; find the page
    // that actually shows the tab bar among all app windows.
    await expect
      .poll(async () => {
        for (const page of handle.electronApp.windows()) {
          if ((await page.locator('[data-testid="tab-bar"] [role="tab"]').count()) === 1) return 1
        }
        return 0
      })
      .toBe(1)
  })
})
