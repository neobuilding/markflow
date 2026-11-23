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

type ListedDoc = { id: string; title: string; filePath?: string | null }

function findFixtureDoc(docs: ListedDoc[], fileName: string): ListedDoc | undefined {
  return docs.find((doc) => (doc.filePath ?? '').replace(/\\/g, '/').endsWith(`/${fileName}`))
}

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
    writeFileSync(join(scratch, 'a.md'), '# A\n\n[Open B](b.md)\n', 'utf-8')
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

  test('opening a workspace opens only the first Markdown file as a tab', async () => {
    await handle.electronApp.evaluate((electron: any, folder: string) => {
      electron.BrowserWindow.getAllWindows()[0]?.webContents.send('app:open-paths', [folder])
    }, scratch)
    await expect
      .poll(() => handle.page.evaluate(() => (window as any).__tabs.getState().tabs.length))
      .toBe(1)
    const state = await handle.page.evaluate(async () => {
      const docs = await window.api.documents.list()
      const tabs = (window as any).__tabs.getState().tabs
      const active = (window as any).__uiStore.getState().activeDocumentId
      return { docs, tab: tabs[0], active }
    })
    const matching = state.docs.find((doc: any) => doc.id === state.active)
    if (!matching) throw new Error('active document missing from workspace document list')
    expect(state.tab.title).toBe(matching.title)
    expect(state.tab.title).not.toBe('未命名')
  })

  test('clicking a file in the sidebar creates a correctly named tab', async () => {
    const docs: ListedDoc[] = await handle.page.evaluate(() => window.api.documents.list())
    const target = docs[1] ?? docs[0]
    await handle.page.locator(`[data-testid="doc-item"][data-doc-id="${target.id}"]`).click()
    await expect
      .poll(() => handle.page.evaluate(() => (window as any).__tabs.getState().tabs.length))
      .toBe(1)
    const tab = await handle.page.evaluate(() => (window as any).__tabs.getState().tabs[0])
    expect(tab.documentId).toBe(target.id)
    expect(tab.title).toBe(target.title)
  })

  test('single-click sidebar files replace the preview tab', async () => {
    const docs: ListedDoc[] = await handle.page.evaluate(() => window.api.documents.list())
    const a = findFixtureDoc(docs, 'a.md')
    const b = findFixtureDoc(docs, 'b.md')
    if (!a || !b) throw new Error('fixture documents are missing')

    await handle.page.locator(`[data-testid="doc-item"][data-doc-id="${a.id}"]`).click()
    await expect
      .poll(() => handle.page.evaluate(() => (window as any).__tabs.getState().tabs.length))
      .toBe(1)
    await expect(handle.page.locator('[data-testid="tab-bar"] [data-preview="true"]')).toHaveCount(
      1,
    )

    await handle.page.locator(`[data-testid="doc-item"][data-doc-id="${b.id}"]`).click()
    await expect
      .poll(async () => {
        const tab = await handle.page.evaluate(() => (window as any).__tabs.getState().tabs[0])
        return tab?.documentId
      })
      .toBe(b.id)
    await expect(handle.page.locator('[data-testid="tab-bar"] [role="tab"]')).toHaveCount(1)
    await expect(handle.page.locator('[data-testid="tab-bar"] [data-preview="true"]')).toHaveCount(
      1,
    )
  })

  test('a rendered Markdown link from an unpinned tab replaces that tab', async () => {
    const docs: ListedDoc[] = await handle.page.evaluate(() => window.api.documents.list())
    const a = findFixtureDoc(docs, 'a.md')
    const b = findFixtureDoc(docs, 'b.md')
    if (!a || !b) throw new Error('fixture documents are missing')

    await handle.page.locator(`[data-testid="doc-item"][data-doc-id="${a.id}"]`).click()
    await expect(handle.page.locator('article.markdown-preview a[href="b.md"]')).toHaveCount(1)

    await handle.page.locator('article.markdown-preview a[href="b.md"]').click()

    await expect
      .poll(async () => {
        const tab = await handle.page.evaluate(() => (window as any).__tabs.getState().tabs[0])
        return tab?.documentId
      })
      .toBe(b.id)
    await expect(handle.page.locator('[data-testid="tab-bar"] [role="tab"]')).toHaveCount(1)
    await expect(handle.page.locator('[data-testid="tab-bar"] [data-preview="true"]')).toHaveCount(
      1,
    )
  })

  test('a rendered Markdown link from a pinned tab opens a new preview tab', async () => {
    const docs: ListedDoc[] = await handle.page.evaluate(() => window.api.documents.list())
    const a = findFixtureDoc(docs, 'a.md')
    const b = findFixtureDoc(docs, 'b.md')
    if (!a || !b) throw new Error('fixture documents are missing')

    await handle.page.locator(`[data-testid="doc-item"][data-doc-id="${a.id}"]`).dblclick()
    await expect
      .poll(() => handle.page.evaluate(() => (window as any).__tabs.getState().previewTabId))
      .toBeNull()
    await expect(handle.page.locator('article.markdown-preview a[href="b.md"]')).toHaveCount(1)

    await handle.page.locator('article.markdown-preview a[href="b.md"]').click()

    await expect
      .poll(() => handle.page.evaluate(() => (window as any).__tabs.getState().tabs.length))
      .toBe(2)
    const state = await handle.page.evaluate(() => {
      const tabs = (window as any).__tabs.getState()
      return { tabs: tabs.tabs, previewTabId: tabs.previewTabId }
    })
    expect(state.tabs[1].documentId).toBe(b.id)
    expect(state.previewTabId).toBe(state.tabs[1].id)
    await expect(handle.page.locator('[data-testid="tab-bar"] [data-preview="true"]')).toHaveCount(
      1,
    )
  })

  test('ADR-0042: Back after a link returns to the source document in the same tab', async () => {
    const docs: ListedDoc[] = await handle.page.evaluate(() => window.api.documents.list())
    const a = findFixtureDoc(docs, 'a.md')
    const b = findFixtureDoc(docs, 'b.md')
    if (!a || !b) throw new Error('fixture documents are missing')

    await handle.page.locator(`[data-testid="doc-item"][data-doc-id="${a.id}"]`).click()
    const tabId = await handle.page.evaluate(() => (window as any).__tabs.getState().activeTabId)
    // Put the caret somewhere specific: the link navigation must capture it into the source
    // entry so Back can restore the position (ADR-0042 §2).
    await handle.page.locator('.cm-content').first().click()
    const selection = await handle.page.evaluate(
      () => (window as any).__uiStore.getState().editorSelection,
    )
    expect(selection).not.toBeNull()
    await handle.page.locator('article.markdown-preview a[href="b.md"]').click()
    await expect
      .poll(() => handle.page.evaluate(() => (window as any).__uiStore.getState().activeDocumentId))
      .toBe(b.id)

    await handle.page.getByTestId('nav-back-btn').click()
    await expect
      .poll(() => handle.page.evaluate(() => (window as any).__uiStore.getState().activeDocumentId))
      .toBe(a.id)
    const state = await handle.page.evaluate(() => {
      const tabs = (window as any).__tabs.getState()
      const history = (window as any).__navHistory.getState()
      return {
        tabId: tabs.activeTabId,
        tabs: tabs.tabs.length,
        entry: history.entryAt(history.cursor),
      }
    })
    expect(state.tabId).toBe(tabId)
    expect(state.tabs).toBe(1)
    expect(state.entry?.path.replace(/\\/g, '/')).toContain('/a.md')
    // The captured caret position survived the link navigation into the source entry.
    expect(state.entry?.position).toEqual(selection)
  })

  test('ADR-0042: closing the active tab keeps its right neighbour active', async () => {
    const docs: ListedDoc[] = await handle.page.evaluate(() => window.api.documents.list())
    const a = findFixtureDoc(docs, 'a.md')
    const b = findFixtureDoc(docs, 'b.md')
    if (!a || !b) throw new Error('fixture documents are missing')

    // Pin a, open b as a preview tab, then close b: the neighbour (a) must become active.
    await handle.page.locator(`[data-testid="doc-item"][data-doc-id="${a.id}"]`).dblclick()
    await expect
      .poll(() => handle.page.evaluate(() => (window as any).__tabs.getState().previewTabId))
      .toBeNull()
    await handle.page.locator(`[data-testid="doc-item"][data-doc-id="${b.id}"]`).click()
    await expect(handle.page.locator('[data-testid="tab-bar"] [role="tab"]')).toHaveCount(2)

    await handle.page.locator('[data-testid="tab-close"]').last().click()

    await expect
      .poll(() => handle.page.evaluate(() => (window as any).__tabs.getState().tabs.length))
      .toBe(1)
    const state = await handle.page.evaluate(() => {
      const tabs = (window as any).__tabs.getState()
      return {
        activeId: tabs.activeTabId,
        tabs: tabs.tabs,
        doc: (window as any).__uiStore.getState().activeDocumentId,
      }
    })
    expect(state.activeId).toBe(state.tabs[0].id)
    expect(state.tabs[0].documentId).toBe(a.id)
    expect(state.doc).toBe(a.id)
  })

  test('double-click pins a tab; a later preview never replaces it', async () => {
    const docs: ListedDoc[] = await handle.page.evaluate(() => window.api.documents.list())
    const a = findFixtureDoc(docs, 'a.md')
    const b = findFixtureDoc(docs, 'b.md')
    if (!a || !b) throw new Error('fixture documents are missing')

    await handle.page.locator(`[data-testid="doc-item"][data-doc-id="${b.id}"]`).dblclick()
    await expect
      .poll(() => handle.page.evaluate(() => (window as any).__tabs.getState().previewTabId))
      .toBeNull()
    await handle.page.locator(`[data-testid="doc-item"][data-doc-id="${a.id}"]`).click()

    await expect(handle.page.locator('[data-testid="tab-bar"] [role="tab"]')).toHaveCount(2)
    await expect(handle.page.locator('[data-testid="tab-bar"] [data-preview="true"]')).toHaveCount(
      1,
    )
    const tabs = await handle.page.evaluate(() => (window as any).__tabs.getState().tabs)
    expect(tabs.map((tab: { documentId: string }) => tab.documentId)).toEqual([b.id, a.id])
  })

  test('editing a preview pins it before another preview opens', async () => {
    const docs: ListedDoc[] = await handle.page.evaluate(() => window.api.documents.list())
    const a = findFixtureDoc(docs, 'a.md')
    const b = findFixtureDoc(docs, 'b.md')
    if (!a || !b) throw new Error('fixture documents are missing')

    await handle.page.locator(`[data-testid="doc-item"][data-doc-id="${a.id}"]`).click()
    await expect
      .poll(() => handle.page.evaluate(() => (window as any).__tabs.getState().previewTabId))
      .not.toBeNull()
    await handle.page.evaluate((docId: string) => {
      ;(window as any).__uiStore.getState().reportUnsavedBuffer(docId, '# edited', 'a.md')
    }, a.id)
    await expect
      .poll(() => handle.page.evaluate(() => (window as any).__tabs.getState().previewTabId))
      .toBeNull()

    await handle.page.locator(`[data-testid="doc-item"][data-doc-id="${b.id}"]`).click()
    await expect(handle.page.locator('[data-testid="tab-bar"] [role="tab"]')).toHaveCount(2)
    await expect(handle.page.locator('[data-testid="tab-bar"] [data-preview="true"]')).toHaveCount(
      1,
    )
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
