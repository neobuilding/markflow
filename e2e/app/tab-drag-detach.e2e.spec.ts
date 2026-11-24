import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, type AppHandle } from '../helpers/launch'
import { resetAppState } from '../helpers/reset'
import { mkTempDir } from '../helpers/temp'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

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

  test('dragging a tab out opens a new window showing that document and workspace', async () => {
    await handle.page.evaluate(async () => {
      const docs = await window.api.documents.list()
      const w = window as any
      w.__tabs.getState().reset()
      const id = w.__tabs.getState().openTab(docs[0].id, { title: docs[0].title })
      w.__tabs.getState().activateTab(id)
    })
    const tab = handle.page.locator('[data-testid="tab-bar"] [role="tab"]').first()
    const opened = handle.electronApp.waitForEvent('window')
    const dataTransfer = await handle.page.evaluateHandle(() => new DataTransfer())
    await tab.dispatchEvent('dragstart', { dataTransfer })
    await tab.dispatchEvent('dragend', { dataTransfer })
    const second = await opened
    await waitForAppReady(second)
    const root = (await handle.page.evaluate(async () =>
      window.api.documents.getWorkspaceRoot(),
    )) as string
    await expect
      .poll(async () => {
        for (const page of handle.electronApp.windows()) {
          if ((await page.locator('[data-testid="tab-bar"] [role="tab"]').count()) === 1) return 1
        }
        return 0
      })
      .toBe(1)
    let destination: Page | undefined
    for (const page of handle.electronApp.windows()) {
      if ((await page.locator('[data-testid="tab-bar"] [role="tab"]').count()) === 1) {
        destination = page
        break
      }
    }
    const state = await destination!.evaluate(async () => {
      const docs = await window.api.documents.list()
      const w = window as any
      return {
        docs: docs.map((doc) => doc.filePath),
        root: await window.api.documents.getWorkspaceRoot(),
        uiRoot: w.__uiStore.getState().workspaceRoot,
        activeDocumentId: w.__uiStore.getState().activeDocumentId,
        tabDocumentId: w.__tabs.getState().tabs[0]?.documentId,
      }
    })
    const normalized = (value: string | null) => value?.replace(/\\/g, '/') ?? null
    expect(state.docs.some((path) => normalized(path) === normalized(join(scratch, 'a.md')))).toBe(
      true,
    )
    expect(state.activeDocumentId).toBe(state.tabDocumentId)
    expect(normalized(state.root)).toBe(normalized(root))
    // The renderer's workspaceRoot mirror is synced asynchronously from main.
    await expect
      .poll(async () =>
        normalized(
          await destination!.evaluate(() => (window as any).__uiStore.getState().workspaceRoot),
        ),
      )
      .toBe(normalized(root))
  })

  test('detaching a dirty tab carries its draft into the new window', async () => {
    await handle.page.evaluate(async () => {
      const docs = await window.api.documents.list()
      const w = window as any
      w.__tabs.getState().reset()
      const id = w.__tabs.getState().openTab(docs[0].id, { title: docs[0].title })
      w.__tabs.getState().activateTab(id)
      w.__uiStore.getState().reportUnsavedBuffer(docs[0].id, '# Dirty A\n', 'dirty.md')
      w.__uiStore.getState().setDirty(true)
    })
    const opened = handle.electronApp.waitForEvent('window')
    await handle.page
      .locator('[data-testid="tab-bar"] [role="tab"]')
      .first()
      .click({ button: 'right' })
    await handle.page.getByTestId('tab-menu-detach').click()
    await waitForAppReady(await opened)
    await expect
      .poll(async () => {
        for (const page of handle.electronApp.windows()) {
          if ((await page.locator('[data-testid="tab-bar"] [role="tab"]').count()) === 1) return 1
        }
        return 0
      })
      .toBe(1)
    let destination: Page | undefined
    for (const page of handle.electronApp.windows()) {
      if ((await page.locator('[data-testid="tab-bar"] [role="tab"]').count()) === 1) {
        destination = page
        break
      }
    }
    const state = await destination!.evaluate(() => {
      const w = window as any
      const docId = w.__tabs.getState().tabs[0]?.documentId
      return {
        docId,
        draft: docId ? w.__uiStore.getState().unsavedBuffers[docId] : undefined,
        dirty: w.__uiStore.getState().dirty,
      }
    })
    expect(state.draft?.content).toBe('# Dirty A\n')
    expect(state.draft?.title).toBe('dirty.md')
    expect(state.dirty).toBe(true)
  })

  test('detaching a non-active tab from a multi-tab window carries its document and workspace', async () => {
    const bPath = join(scratch, 'b.md')
    writeFileSync(bPath, '# Detached B\n', 'utf-8')
    await handle.page.evaluate(async (file) => {
      await window.api.documents.import(file)
      const docs = await window.api.documents.list()
      const w = window as any
      w.__tabs.getState().reset()
      const first = docs.find((doc: any) => doc.filePath.endsWith('a.md'))
      const second = docs.find((doc: any) => doc.filePath.endsWith('b.md'))
      if (!first || !second) throw new Error('detach fixture documents are missing')
      w.__tabs.getState().openTab(first.id, { title: first.title })
      w.__tabs.getState().openTab(second.id, { title: second.title, activate: false })
    }, bPath)
    await expect(handle.page.locator('[data-testid="tab-bar"] [role="tab"]')).toHaveCount(2)

    const opened = handle.electronApp.waitForEvent('window')
    await handle.page
      .locator('[data-testid="tab-bar"] [role="tab"]')
      .nth(1)
      .click({ button: 'right' })
    await handle.page.getByTestId('tab-menu-detach').click()
    await waitForAppReady(await opened)
    await expect
      .poll(async () => {
        for (const page of handle.electronApp.windows()) {
          if ((await page.locator('[data-testid="tab-bar"] [role="tab"]').count()) === 1) return 1
        }
        return 0
      })
      .toBe(1)
    let destination: Page | undefined
    for (const page of handle.electronApp.windows()) {
      if ((await page.locator('[data-testid="tab-bar"] [role="tab"]').count()) === 1) {
        destination = page
        break
      }
    }
    const state = await destination!.evaluate(async () => {
      const docs = await window.api.documents.list()
      const w = window as any
      return {
        paths: docs.map((doc) => doc.filePath),
        root: await window.api.documents.getWorkspaceRoot(),
        uiRoot: w.__uiStore.getState().workspaceRoot,
        activeDocumentId: w.__uiStore.getState().activeDocumentId,
        tabDocumentId: w.__tabs.getState().tabs[0]?.documentId,
      }
    })
    const normalized = (value: string | null) => value?.replace(/\\/g, '/') ?? null
    expect(state.paths.some((path) => normalized(path) === normalized(bPath))).toBe(true)
    expect(state.activeDocumentId).toBe(state.tabDocumentId)
    expect(normalized(state.root)).toBe(normalized(scratch))
    expect(normalized(state.uiRoot)).toBe(normalized(scratch))
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
    // Drive the REAL context-menu path: it builds the handoff via buildTabHandoff and calls
    // beginTabDrag/detachTabToNewWindow, unlike the old hand-written payload.
    await handle.page
      .locator('[data-testid="tab-bar"] [role="tab"]')
      .first()
      .click({ button: 'right' })
    await handle.page.getByTestId('tab-menu-detach').click()
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

    // The destination must show the re-imported document AND be rooted at the file's folder.
    // A window with an empty tab strip / empty workspace silently satisfies the old assertion.
    let destinationPage: Page | undefined
    for (const page of handle.electronApp.windows()) {
      if ((await page.locator('[data-testid="tab-bar"] [role="tab"]').count()) === 1) {
        destinationPage = page
        break
      }
    }
    expect(destinationPage).toBeTruthy()
    const state = await destinationPage!.evaluate(async () => {
      const docs = await window.api.documents.list()
      const root = await window.api.documents.getWorkspaceRoot()
      const w = window as any
      return {
        docs: docs.map((doc) => ({ id: doc.id, filePath: doc.filePath })),
        root,
        uiRoot: w.__uiStore.getState().workspaceRoot,
        activeDocumentId: w.__uiStore.getState().activeDocumentId,
        tabDocumentId: w.__tabs.getState().tabs[0]?.documentId,
      }
    })
    const normalized = (value: string | null) => value?.replace(/\\/g, '/') ?? null
    expect(
      state.docs.some((doc) => normalized(doc.filePath) === normalized(join(scratch, 'a.md'))),
    ).toBe(true)
    expect(state.activeDocumentId).toBe(state.tabDocumentId)
    expect(normalized(state.root)).toBe(normalized(scratch))
    expect(normalized(state.uiRoot)).toBe(normalized(scratch))
  })

  // Requirement-driven, black-box case: a detach must reopen the SOURCE workspace, not merely
  // the handed-off file's parent folder. A tab in `sub/b.md` must leave both windows showing
  // `a.md` at the workspace root and the `sub` folder in the tree. No store/IPC peeking here:
  // these are the rows the user actually looks at.
  test('detaching a tab from a subfolder reopens the source workspace, not just its folder', async () => {
    const subDir = join(scratch, 'sub')
    const bPath = join(subDir, 'b.md')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(bPath, '# Detached B\n', 'utf-8')
    await handle.page.evaluate(async (file) => {
      await window.api.documents.import(file)
      const docs = await window.api.documents.list()
      const w = window as any
      const doc = docs.find((item: any) => item.filePath.endsWith('b.md'))
      if (!doc) throw new Error('detach fixture document is missing')
      w.__tabs.getState().reset()
      const id = w.__tabs.getState().openTab(doc.id, { title: doc.title })
      w.__tabs.getState().activateTab(id)
      w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
    }, bPath)

    await expect(handle.page.getByTestId('current-folder-bar')).toContainText(basename(scratch))
    await expect(handle.page.getByTestId('doc-item').filter({ hasText: 'a' })).toBeVisible()

    const opened = handle.electronApp.waitForEvent('window')
    await handle.page
      .locator('[data-testid="tab-bar"] [role="tab"]')
      .first()
      .click({ button: 'right' })
    await handle.page.getByTestId('tab-menu-detach').click()
    await waitForAppReady(await opened)
    await expect
      .poll(async () => {
        for (const page of handle.electronApp.windows()) {
          if ((await page.locator('[data-testid="tab-bar"] [role="tab"]').count()) === 1) return 1
        }
        return 0
      })
      .toBe(1)
    const destination = handle.electronApp.windows().find((page) => page !== handle.page) as Page

    await expect(destination.getByTestId('current-folder-bar')).toContainText(basename(scratch))
    await expect(destination.getByTestId('doc-item').filter({ hasText: 'a' })).toBeVisible()
    await expect(destination.getByTestId('folder-row').filter({ hasText: 'sub' })).toBeVisible()
  })

  // Requirements-driven matrix for "detach to new window" (ADR-0040 §3.5): pin state,
  // active state and file location are independent dimensions. Every row asserts the same
  // USER-VISIBLE contract through DOM locators — one tab carrying the target document,
  // the source workspace folder bar, and the workspace tree — not internal store state.
  for (const scenario of [
    { name: 'root file, active, pinned', sub: false, active: true, pinned: true },
    { name: 'root file, non-active, preview', sub: false, active: false, pinned: false },
    { name: 'subfolder file, active, preview', sub: true, active: true, pinned: false },
    { name: 'subfolder file, non-active, pinned', sub: true, active: false, pinned: true },
  ]) {
    test(`detach matrix: ${scenario.name}`, async () => {
      const subDir = join(scratch, 'sub')
      const bPath = join(subDir, 'b.md')
      mkdirSync(subDir, { recursive: true })
      writeFileSync(bPath, '# Detached B\n', 'utf-8')
      await handle.page.evaluate(
        async ({ file, sub, active, pinned }) => {
          await window.api.documents.import(file)
          const docs = await window.api.documents.list()
          const w = window as any
          const a = docs.find((doc: any) => doc.filePath.endsWith('a.md'))
          const b = docs.find((doc: any) => doc.filePath.endsWith('b.md'))
          if (!a || !b) throw new Error('detach matrix fixtures are missing')
          w.__tabs.getState().reset()
          const aTab = w.__tabs.getState().openTab(a.id, { title: a.title, preview: true })
          const bTab = w.__tabs.getState().openTab(b.id, { title: b.title, preview: false })
          const targetTab = sub ? bTab : aTab
          if (pinned) w.__tabs.getState().pinTab(targetTab)
          w.__tabs.getState().activateTab(active ? targetTab : sub ? aTab : bTab)
          w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
        },
        { file: bPath, ...scenario },
      )

      const targetTitle = scenario.sub ? 'b' : 'a'
      const tab = handle.page
        .locator('[data-testid="tab-bar"] [role="tab"]')
        .filter({ hasText: targetTitle })
      const opened = handle.electronApp.waitForEvent('window')
      await tab.click({ button: 'right' })
      await handle.page.getByTestId('tab-menu-detach').click()
      await waitForAppReady(await opened)
      await expect
        .poll(async () => {
          for (const page of handle.electronApp.windows()) {
            if ((await page.locator('[data-testid="tab-bar"] [role="tab"]').count()) === 1) return 1
          }
          return 0
        })
        .toBe(1)
      const destination = handle.electronApp.windows().find((page) => page !== handle.page) as Page

      await expect(destination.locator('[data-testid="tab-bar"] [role="tab"]')).toHaveCount(1)
      await expect(
        destination
          .locator('[data-testid="tab-bar"] [role="tab"]')
          .filter({ hasText: targetTitle }),
      ).toBeVisible()
      await expect(destination.getByTestId('current-folder-bar')).toContainText(basename(scratch))
      await expect(destination.getByTestId('doc-item').filter({ hasText: 'a' })).toBeVisible()
      await expect(destination.getByTestId('folder-row').filter({ hasText: 'sub' })).toBeVisible()
    })
  }
})
