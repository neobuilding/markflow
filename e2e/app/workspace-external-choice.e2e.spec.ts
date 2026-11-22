import { test, expect, type Page } from '@playwright/test'
import {
  launchApp,
  waitForAppReady,
  closeApp,
  installConfirmSpy,
  getConfirmCalls,
  type AppHandle,
} from '../helpers/launch'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir } from '../helpers/temp'
import { resetAppState } from '../helpers/reset'

// The four-way choice for a Markdown file that resolves OUTSIDE the current workspace
// (ADR-0039 §3.2): open in a new window / open here keeping the workspace / open here and
// switch the workspace / cancel.
//
// The DECISION logic is unit-tested (src/renderer/src/lib/workspaceExternalDecision.test.ts and
// workspaceSwitch.test.ts). What only a real Electron run can prove is the wiring: the native
// four-button box, the second BrowserWindow, the per-window workspace root, and the fact that
// the external document stays out of the sidebar tree.
const LINK = 'article.markdown-preview a[href="../outside/outside.md"]'

test.describe('workspace-external four-way choice', () => {
  test.describe.configure({ mode: 'serial' })
  let handle: AppHandle
  let scratch: string
  let workspace: string
  let outsideDir: string
  let outsideFile: string
  let indexFile: string

  test.beforeAll(async () => {
    handle = await launchApp()
  })

  test.beforeEach(async () => {
    await resetAppState(handle)
    scratch = mkTempDir('markflow-ws-ext-')
    workspace = join(scratch, 'workspace')
    outsideDir = join(scratch, 'outside')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(outsideDir, { recursive: true })
    indexFile = join(workspace, 'index.md')
    outsideFile = join(outsideDir, 'outside.md')
    writeFileSync(indexFile, '# Index\n\n[Outside](../outside/outside.md)\n', 'utf-8')
    writeFileSync(outsideFile, '# Outside\n\nOutside body.\n', 'utf-8')
    await openIndex(handle.page, workspace, indexFile)
  })

  test.afterEach(async () => {
    // The "new window" case opens a second BrowserWindow. Close every window but the first so
    // the next case starts from a single-window app again.
    for (const extra of handle.electronApp.windows().slice(1)) {
      await extra.close()
    }
  })

  test.afterAll(async () => {
    await closeApp(handle)
  })

  test('offers exactly four exits and defaults to the new window', async () => {
    await installConfirmSpy(handle, { defaultResponse: 3 })
    await handle.page.locator(LINK).click()

    await expect.poll(async () => (await getConfirmCalls(handle)).length).toBe(1)
    const call = (await getConfirmCalls(handle))[0]
    expect(call.buttons).toEqual([
      'Open in new window',
      'Open here (keep workspace)',
      'Open here & switch workspace',
      'Cancel',
    ])
    expect(call.defaultId).toBe(0)
    expect(call.cancelId).toBe(3)
  })

  test('opens a SECOND window for the new-window choice and leaves this one alone', async () => {
    await installConfirmSpy(handle, { defaultResponse: 0 })
    const opened = handle.electronApp.waitForEvent('window')
    await handle.page.locator(LINK).click()
    const second = await opened
    await waitForAppReady(second)

    expect(handle.electronApp.windows().length).toBe(2)
    // The new window owns the file AND its folder as its workspace.
    await expect.poll(() => workspaceRoot(second)).toBe(norm(outsideDir))
    await expect.poll(() => activeDocPath(second)).toBe(norm(outsideFile))
    // The window the user came from keeps its own workspace.
    await expect.poll(() => workspaceRoot(handle.page)).toBe(norm(workspace))
  })

  test('opens the file here and keeps the workspace for the keep-workspace choice', async () => {
    await installConfirmSpy(handle, { defaultResponse: 1 })
    await handle.page.locator(LINK).click()

    await expect.poll(() => activeDocPath(handle.page)).toBe(norm(outsideFile))
    // The workspace did NOT move.
    await expect.poll(() => workspaceRoot(handle.page)).toBe(norm(workspace))
    // An external document is not part of the workspace tree. The row's `data-path` carries
    // the path in the shape the store holds it (the host's separators on Windows), so the
    // check compares NORMALIZED paths inside the page instead of matching a selector.
    await expect
      .poll(() =>
        handle.page.evaluate(
          (target) =>
            [...document.querySelectorAll<HTMLElement>('[data-testid="doc-item"]')].some(
              (el) => (el.dataset.path ?? '').replace(/\\/g, '/') === target,
            ),
          norm(outsideFile),
        ),
      )
      .toBe(false)
  })

  test('opens the file here and moves the workspace for the switch-workspace choice', async () => {
    await installConfirmSpy(handle, { defaultResponse: 2 })
    await handle.page.locator(LINK).click()

    // The workspace follows the file …
    await expect.poll(() => workspaceRoot(handle.page)).toBe(norm(outsideDir))
    // … AND the picked file becomes the active document (not the previous one).
    await expect.poll(() => activeDocPath(handle.page)).toBe(norm(outsideFile))
  })

  test('changes nothing for the cancel choice', async () => {
    await installConfirmSpy(handle, { defaultResponse: 3 })
    await handle.page.locator(LINK).click()

    await expect.poll(async () => (await getConfirmCalls(handle)).length).toBe(1)
    await expect.poll(() => workspaceRoot(handle.page)).toBe(norm(workspace))
    expect(await activeDocPath(handle.page)).toBe(norm(indexFile))
  })

  test('the switch-workspace exit uses the file guard and restores focus on Keep editing', async () => {
    const { page } = handle
    await page.evaluate(() => (window as any).__uiStore.getState().setEditable(true))
    await page.locator('.cm-content').click()
    await page.keyboard.type(' UNSAVED')
    await expect(page.locator('.cm-content')).toContainText('UNSAVED')

    // First dialog: four-way choice -> "Open here & switch workspace". Second: the single
    // unsaved-FILE guard; "Keep editing" must cancel the swap and return focus to the editor.
    await installConfirmSpy(handle, { responses: [2, 0] })
    await page.locator(LINK).click()

    await expect.poll(async () => (await getConfirmCalls(handle)).length).toBe(2)
    const calls = await getConfirmCalls(handle)
    expect(calls[0].buttons).toHaveLength(4)
    expect(calls[1].message).toContain('switch files?')
    expect(calls[1].message).not.toContain('new workspace')
    await expect(page.locator('.cm-content')).toContainText('UNSAVED')
    expect(await workspaceRoot(page)).toBe(norm(workspace))
    const focused = await page.evaluate(() => document.activeElement?.className ?? '')
    expect(focused).toContain('cm-content')
  })
})

async function openIndex(page: Page, root: string, file: string): Promise<void> {
  await page.evaluate(
    async ({ root, file }) => {
      await window.api.documents.setWorkspaceRoot(root)
      const doc = await window.api.documents.import(file)
      const w = window as any
      w.__uiStore.getState().setWorkspaceRoot(root)
      w.__uiStore.getState().setActiveDocumentId(doc?.id ?? null)
      w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
    },
    { root, file },
  )
  await expect(page.locator('article.markdown-preview')).toBeVisible()
}

// The document store keeps forward slashes while node:path.join() uses the host separator, so
// compare paths in one canonical shape (docs/agents/testing.md).
const norm = (p: string | null): string | null => (p ? p.replace(/\\/g, '/') : p)

async function workspaceRoot(page: Page): Promise<string | null> {
  const root = await page.evaluate(async () => await window.api.documents.getWorkspaceRoot())
  return norm(root)
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
