import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, type AppHandle } from '../helpers/launch'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir } from '../helpers/temp'
import { resetAppState } from '../helpers/reset'

// Multi-window behaviour (ADR-0039 §3.4): every window owns its workspace root, its document
// store and its watcher, and closing one window must NOT take the application down.
//
// The per-window plumbing is unit-tested (electron/main/model/windowContext.test.ts,
// ipcScope.test.ts, ipc/newWindow.test.ts). What only a real Electron run can prove is that
// two BrowserWindows really do keep two separate workspaces, that the reuse branch focuses the
// right window, and that the app survives the loss of one of them.
test.describe('multi-window isolation', () => {
  test.describe.configure({ mode: 'serial' })
  let handle: AppHandle
  let scratch: string
  let rootA: string
  let rootB: string
  let fileA: string
  let fileB: string

  test.beforeAll(async () => {
    handle = await launchApp()
  })

  test.beforeEach(async () => {
    await resetAppState(handle)
    scratch = mkTempDir('markflow-multi-')
    rootA = join(scratch, 'a')
    rootB = join(scratch, 'b')
    mkdirSync(rootA, { recursive: true })
    mkdirSync(rootB, { recursive: true })
    fileA = join(rootA, 'a.md')
    fileB = join(rootB, 'b.md')
    writeFileSync(fileA, '# A\n', 'utf-8')
    writeFileSync(fileB, '# B\n', 'utf-8')
    await setRoot(handle.page, rootA)
  })

  test.afterEach(async () => {
    for (const extra of handle.electronApp.windows().slice(1)) {
      await extra.close()
    }
  })

  test.afterAll(async () => {
    await closeApp(handle)
  })

  test('a second window gets its OWN workspace and document store', async () => {
    const second = await openSecondWindow(handle, fileB)

    expect(handle.electronApp.windows().length).toBe(2)
    // Different roots …
    await expect.poll(() => workspaceRoot(handle.page)).toBe(norm(rootA))
    await expect.poll(() => workspaceRoot(second)).toBe(norm(rootB))
    // … and different documents: the second window's file is invisible to the first.
    await expect.poll(() => docPaths(second)).toEqual([norm(fileB)])
    expect(await docPaths(handle.page)).not.toContain(norm(fileB))
  })

  test('a disk change in one workspace refreshes only that window', async () => {
    const second = await openSecondWindow(handle, fileB)
    await expect.poll(() => docPaths(second)).toEqual([norm(fileB)])
    // Keep window A focused: the old implementation sent every watcher broadcast to
    // getMainWindow(), so B (the owner) never refreshed and A received an irrelevant event.
    await handle.page.bringToFront()

    const added = join(rootB, 'added.md')
    writeFileSync(added, '# Added\n', 'utf-8')

    await expect.poll(() => docPaths(second)).toContain(norm(added))
    expect(await docPaths(handle.page)).not.toContain(norm(added))
  })

  test('a file a window already owns REUSES that window instead of opening a third', async () => {
    const second = await openSecondWindow(handle, fileB)

    // The first window's workspace contains fileA, so asking for it must focus that window.
    await second.evaluate((path) => window.api.app.openInNewWindow(path), fileA)

    expect(handle.electronApp.windows().length).toBe(2)
    // The owning window revealed the file — it is the active document there now.
    await expect.poll(() => activeDocPath(handle.page)).toBe(norm(fileA))
  })

  test('right-click Open in new window on an in-workspace file really opens a second window', async () => {
    // fileA lives inside rootA, which the current window owns. The context-menu action used to
    // match that same window as the "reuse" target, so it silently did nothing.
    await handle.page.evaluate(async (path) => {
      const doc = await window.api.documents.import(path)
      const w = window as any
      if (doc) w.__uiStore.getState().setActiveDocumentId(doc.id)
      w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
    }, fileA)
    const row = handle.page.getByTestId('doc-item').filter({ hasText: 'a.md' })
    await expect(row).toBeVisible()

    const opened = handle.electronApp.waitForEvent('window')
    await row.click({ button: 'right' })
    await handle.page.getByTestId('side-open-in-new-window').click()
    const second = await opened
    await waitForAppReady(second)

    expect(handle.electronApp.windows().length).toBe(2)
    await expect.poll(() => workspaceRoot(second)).toBe(norm(rootA))
  })

  test('closing one window leaves the application running', async () => {
    const second = await openSecondWindow(handle, fileB)
    expect(handle.electronApp.windows().length).toBe(2)

    await second.close()

    // The app is still alive with the remaining window (D14: only the LAST window's close
    // ends the application on Win/Linux; macOS always keeps the process).
    await expect.poll(() => handle.electronApp.windows().length).toBe(1)
    await expect(handle.page.locator('#root')).toBeVisible()
    await expect.poll(() => workspaceRoot(handle.page)).toBe(norm(rootA))
  })
})

async function openSecondWindow(handle: AppHandle, file: string): Promise<Page> {
  const opened = handle.electronApp.waitForEvent('window')
  await handle.page.evaluate((path) => window.api.app.openInNewWindow(path), file)
  const second = await opened
  await waitForAppReady(second)
  return second
}

async function setRoot(page: Page, root: string): Promise<void> {
  await page.evaluate(async (r) => {
    await window.api.documents.setWorkspaceRoot(r)
    const w = window as any
    w.__uiStore.getState().setWorkspaceRoot(r)
    w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
  }, root)
  await expect(page.locator('#root')).toBeVisible()
}

// The document store keeps forward slashes while node:path.join() uses the host separator, so
// compare paths in one canonical shape (docs/agents/testing.md).
const norm = (p: string | null): string | null => (p ? p.replace(/\\/g, '/') : p)

async function workspaceRoot(page: Page): Promise<string | null> {
  const root = await page.evaluate(async () => await window.api.documents.getWorkspaceRoot())
  return norm(root)
}

async function docPaths(page: Page): Promise<(string | null)[]> {
  const paths = await page.evaluate(async () => {
    const docs = await window.api.documents.list()
    return docs.map((d: { filePath: string }) => d.filePath)
  })
  return paths.map(norm)
}

async function activeDocPath(page: Page): Promise<string | null> {
  const path = await page.evaluate(async () => {
    const w = window as any
    const id = w.__uiStore.getState().activeDocumentId as string | null
    if (!id) return null
    const doc = await window.api.documents.get(id)
    return doc?.filePath ?? null
  })
  return norm(path)
}
