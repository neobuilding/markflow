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
import { expectTooltipText, hoverTooltip } from '../helpers/tooltip'
import { resetAppState } from '../helpers/reset'

// Regression loop for: clicking a relative link in the preview must NOT navigate
// the whole Electron window (which wiped the React UI and left a blank/hung app).
// The target document should be opened in-app instead.
//
// Several cases set the workspace root and import documents, so this is a stateful serial group:
// one Electron launch, a full two-process reset before each case (docs/agents/testing.md).
test.describe('markdown link navigation', () => {
  test.describe.configure({ mode: 'serial' })
  let handle: AppHandle
  let scratch: string

  test.beforeAll(async () => {
    handle = await launchApp()
  })

  test.beforeEach(async () => {
    await resetAppState(handle)
    scratch = mkTempDir('markflow-links-')
  })

  test.afterAll(async () => {
    await closeApp(handle)
  })

  test('a left-click on a relative .md link opens the target doc without navigating the window', async () => {
    const { page } = handle
    await waitForAppReady(page)

    const indexFile = join(scratch, 'index.md')
    const targetFile = join(scratch, 'target.md')
    writeFileSync(indexFile, '# Index\n\n[Go to target](target.md)\n', 'utf-8')
    writeFileSync(targetFile, '# Target\n\nTarget body.\n', 'utf-8')

    const ids = await page.evaluate(
      async ({ indexFile, targetFile }) => {
        const index = await window.api.documents.import(indexFile)
        const target = await window.api.documents.import(targetFile)
        return { indexId: index?.id ?? null, targetId: target?.id ?? null }
      },
      { indexFile, targetFile },
    )
    expect(ids.indexId).toBeTruthy()
    expect(ids.targetId).toBeTruthy()

    await activate(page, ids.indexId!)
    await expect(page.locator('article.markdown-preview a[href="target.md"]')).toHaveCount(1)

    const urlBefore = page.url()
    await page.locator('article.markdown-preview a[href="target.md"]').click({ noWaitAfter: true })

    // The window must stay on the app shell: no file:// navigation, no blank page.
    await expect(page.locator('article.markdown-preview')).toBeVisible()
    expect(page.url()).toBe(urlBefore)

    // The linked document becomes the active one in the same window. Assert by PATH, not by the
    // id from import above: with no workspace root set, navigateToPath calls setWorkspaceRoot,
    // which clears the document store and re-imports the file with a NEW id (ADR-0038 §3.2 —
    // ids are invalid across a workspace change; the absolute path is the durable key).
    await expect.poll(() => activeDocPath(page)).toBe(norm(targetFile))
  })

  test('a link to a nested file expands its folder and reveals the row', async () => {
    const { page } = handle
    await waitForAppReady(page)

    const nested = join(scratch, 'nested')
    mkdirSync(nested, { recursive: true })
    const indexFile = join(scratch, 'index.md')
    const targetFile = join(nested, 'deep-target.md')
    writeFileSync(indexFile, '# Index\n\n[Deep](nested/deep-target.md)\n', 'utf-8')
    writeFileSync(targetFile, '# Deep target\n', 'utf-8')

    const ids = await page.evaluate(
      async ({ root, indexFile, targetFile }) => {
        await window.api.documents.setWorkspaceRoot(root)
        const index = await window.api.documents.import(indexFile)
        const target = await window.api.documents.import(targetFile)
        const w = window as any
        w.__uiStore.getState().setWorkspaceRoot(root)
        w.__uiStore.getState().setActiveDocumentId(index?.id ?? null)
        w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
        return { indexId: index?.id ?? null, targetId: target?.id ?? null }
      },
      { root: scratch, indexFile, targetFile },
    )
    expect(ids.indexId).toBeTruthy()
    expect(ids.targetId).toBeTruthy()

    // Reveal follows the absolute path: the click may re-import the target under a new id when
    // the workspace moves into the nested folder (ADR-0038 §3.2), so address rows by data-path.
    const targetRow = page.locator(`[data-testid="doc-item"][data-path="${norm(targetFile)}"]`)
    await expect(page.locator(`[data-doc-id="${ids.indexId}"]`)).toBeVisible()
    // Folders start collapsed: the target row is absent until reveal expands its ancestors.
    await expect(targetRow).toHaveCount(0)

    await page.locator('article.markdown-preview a[href="nested/deep-target.md"]').click()

    await expect(targetRow).toBeVisible()
    await expect.poll(() => activeDocPath(page)).toBe(norm(targetFile))
    // Reveal is not just a DOM presence check: the row must be inside the scroll viewport.
    const box = await targetRow.boundingBox()
    const area = await page.getByTestId('sidebar-tree-area').boundingBox()
    expect(box && area && box.y >= area.y && box.y + box.height <= area.y + area.height).toBe(true)
  })

  test('an ellipsized file name shows its full path on hover', async () => {
    const { page } = handle
    await waitForAppReady(page)

    const longName = 'an-extremely-long-document-name-that-cannot-fit-in-the-sidebar.md'
    const longFile = join(scratch, longName)
    writeFileSync(longFile, '# Long\n', 'utf-8')
    const id = await page.evaluate(
      async ({ root, longFile }) => {
        await window.api.documents.setWorkspaceRoot(root)
        const doc = await window.api.documents.import(longFile)
        const w = window as any
        w.__uiStore.getState().setWorkspaceRoot(root)
        w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
        return doc?.id ?? null
      },
      { root: scratch, longFile },
    )
    expect(id).toBeTruthy()

    const testId = `sidebar-doc-name-${id}`
    const label = page.getByTestId(testId)
    await expect(label).toBeVisible()
    expect(await label.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
    await expectTooltipText(page, testId, longName)
    const text = (await (await hoverTooltip(page, testId)).first().textContent()) ?? ''
    // VS Code-style content: the full resource path, not just the basename.
    expect(text.replace(/\\/g, '/')).toContain(longFile.replace(/\\/g, '/'))
  })

  test('a file:/// link survives rendering and opens the linked document', async () => {
    const { page } = handle
    const indexFile = join(scratch, 'index.md')
    const targetFile = join(scratch, 'file-target.md')
    writeFileSync(
      indexFile,
      `# Index\n\n[File](file:///${targetFile.replace(/\\/g, '/')})\n`,
      'utf-8',
    )
    writeFileSync(targetFile, '# File target\n', 'utf-8')

    const ids = await page.evaluate(
      async ({ indexFile, targetFile }) => {
        const index = await window.api.documents.import(indexFile)
        const target = await window.api.documents.import(targetFile)
        return { indexId: index?.id ?? null, targetId: target?.id ?? null }
      },
      { indexFile, targetFile },
    )
    expect(ids.indexId).toBeTruthy()
    expect(ids.targetId).toBeTruthy()

    await activate(page, ids.indexId!)
    // The actual regression: markdown-it's default validateLink used to turn this into
    // plain text, and DOMPurify stripped it from any anchor that did get through.
    const link = page.locator('article.markdown-preview a[href^="file:///"]')
    await expect(link).toHaveCount(1)
    const urlBefore = page.url()
    await link.click()

    await expect.poll(() => activeDocPath(page)).toBe(norm(targetFile))
    expect(page.url()).toBe(urlBefore)
  })

  test('a Windows drive-path link opens the linked document', async () => {
    test.skip(process.platform !== 'win32', 'drive paths are Windows-specific')
    const { page } = handle
    const indexFile = join(scratch, 'index.md')
    const targetFile = join(scratch, 'drive-target.md')
    writeFileSync(indexFile, `# Index\n\n[Drive](${targetFile})\n`, 'utf-8')
    writeFileSync(targetFile, '# Drive target\n', 'utf-8')

    const ids = await page.evaluate(
      async ({ indexFile, targetFile }) => {
        const index = await window.api.documents.import(indexFile)
        const target = await window.api.documents.import(targetFile)
        return { indexId: index?.id ?? null, targetId: target?.id ?? null }
      },
      { indexFile, targetFile },
    )
    expect(ids.indexId).toBeTruthy()
    expect(ids.targetId).toBeTruthy()

    await activate(page, ids.indexId!)
    // The scratch directory can be on any drive — use the path's own drive letter.
    const drive = targetFile.slice(0, 2)
    const link = page.locator(`article.markdown-preview a[href^="${drive}"]`)
    await expect(link).toHaveCount(1)
    await link.click()
    await expect.poll(() => activeDocPath(page)).toBe(norm(targetFile))
  })

  test('Back returns to the previous file and Forward returns to the linked file', async () => {
    const { page } = handle
    const indexFile = join(scratch, 'index.md')
    const targetFile = join(scratch, 'target.md')
    writeFileSync(indexFile, '# Index\n\n[Go](target.md)\n', 'utf-8')
    writeFileSync(targetFile, '# Target\n', 'utf-8')
    const ids = await page.evaluate(
      async ({ indexFile, targetFile }) => {
        const index = await window.api.documents.import(indexFile)
        const target = await window.api.documents.import(targetFile)
        return { indexId: index?.id ?? null, targetId: target?.id ?? null }
      },
      { indexFile, targetFile },
    )
    expect(ids.indexId).toBeTruthy()
    await activate(page, ids.indexId!)
    await page.locator('article.markdown-preview a[href="target.md"]').click()
    await expect.poll(() => activeDocPath(page)).toBe(norm(targetFile))

    const back = page.getByTestId('nav-back-btn')
    const forward = page.getByTestId('nav-forward-btn')
    await expect(back).toBeEnabled()
    await expect(forward).toBeDisabled()
    await back.click()
    await expect.poll(() => activeDocPath(page)).toBe(norm(indexFile))
    await expect(forward).toBeEnabled()
    await forward.click()
    await expect.poll(() => activeDocPath(page)).toBe(norm(targetFile))
  })

  test('Alt+ArrowLeft walks history, but the editor keeps its own ArrowLeft', async () => {
    const { page } = handle
    const indexFile = join(scratch, 'index.md')
    const targetFile = join(scratch, 'target.md')
    writeFileSync(indexFile, '# Index\n\n[Go](target.md)\n', 'utf-8')
    writeFileSync(targetFile, '# Target\n', 'utf-8')
    const ids = await page.evaluate(
      async ({ indexFile, targetFile }) => {
        const index = await window.api.documents.import(indexFile)
        const target = await window.api.documents.import(targetFile)
        return { indexId: index?.id ?? null, targetId: target?.id ?? null }
      },
      { indexFile, targetFile },
    )
    expect(ids.indexId).toBeTruthy()
    await activate(page, ids.indexId!)
    await page.locator('article.markdown-preview a[href="target.md"]').click()
    await expect.poll(() => activeDocPath(page)).toBe(norm(targetFile))

    // Focus is outside the editor after the link click → the browser-style shortcut moves back.
    await page.keyboard.press('Alt+ArrowLeft')
    await expect.poll(() => activeDocPath(page)).toBe(norm(indexFile))

    // Re-enter the target, then focus the editor: the same chord must stay with CodeMirror
    // (syntax movement), NOT trigger a second history move. A read-only .cm-content is not
    // focusable, so the app must be switched to edit mode first — otherwise focus stays on <body>
    // and this case would exercise the browser shortcut instead of the editor one.
    await page.getByTestId('nav-forward-btn').click()
    await expect.poll(() => activeDocPath(page)).toBe(norm(targetFile))
    await page.evaluate(() => (window as any).__uiStore.getState().setEditable(true))
    await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true')
    await page.locator('.cm-content').click()
    await expect(page.locator('.cm-content')).toBeFocused()
    await page.keyboard.press('Alt+ArrowLeft')
    await expect.poll(() => activeDocPath(page)).toBe(norm(targetFile))
  })

  test('an external link asks for confirmation and Cancel leaves the app alone', async () => {
    const { page } = handle
    const indexFile = join(scratch, 'index.md')
    writeFileSync(indexFile, '# Index\n\n[Web](https://example.com/paper.pdf)\n', 'utf-8')
    const id = await page.evaluate(
      async ({ indexFile }) => {
        const doc = await window.api.documents.import(indexFile)
        return doc?.id ?? null
      },
      { indexFile },
    )
    expect(id).toBeTruthy()

    await activate(page, id!)
    // Third button = Cancel; the OS handler must never see this target.
    await installConfirmSpy(handle, { defaultResponse: 2 })
    const urlBefore = page.url()
    await page.locator('article.markdown-preview a[href="https://example.com/paper.pdf"]').click()

    await expect.poll(async () => (await getConfirmCalls(handle)).length).toBe(1)
    const call = (await getConfirmCalls(handle))[0]
    expect(call.buttons).toHaveLength(3)
    expect(call.cancelId).toBe(2)
    expect(call.detail).toContain('https://example.com/paper.pdf')
    expect(page.url()).toBe(urlBefore)
  })

  test('a leading-slash link resolves against the workspace root', async () => {
    const { page } = handle
    mkdirSync(join(scratch, 'docs'), { recursive: true })
    const indexFile = join(scratch, 'index.md')
    const targetFile = join(scratch, 'docs', 'abs-target.md')
    writeFileSync(indexFile, '# Index\n\n[Abs](/docs/abs-target.md)\n', 'utf-8')
    writeFileSync(targetFile, '# Abs target\n', 'utf-8')

    const ids = await page.evaluate(
      async ({ root, indexFile, targetFile }) => {
        await window.api.documents.setWorkspaceRoot(root)
        const index = await window.api.documents.import(indexFile)
        const target = await window.api.documents.import(targetFile)
        const w = window as any
        w.__uiStore.getState().setWorkspaceRoot(root)
        w.__uiStore.getState().setActiveDocumentId(index?.id ?? null)
        w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
        return { indexId: index?.id ?? null, targetId: target?.id ?? null }
      },
      { root: scratch, indexFile, targetFile },
    )
    expect(ids.indexId).toBeTruthy()
    expect(ids.targetId).toBeTruthy()

    await activate(page, ids.indexId!)
    await page.locator('article.markdown-preview a[href="/docs/abs-target.md"]').click()
    await expect.poll(() => activeDocPath(page)).toBe(norm(targetFile))
  })
})

async function activate(page: Page, id: string): Promise<void> {
  await page.evaluate((id) => {
    const w = window as any
    w.__uiStore.getState().setActiveDocumentId(id)
    w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
  }, id)
  await expect(page.locator('article.markdown-preview')).toBeVisible()
}

// The document store keeps forward slashes while node:path.join() uses the host separator, so
// compare paths in one canonical shape (docs/agents/testing.md — never inherit the host path shape).
const norm = (p: string | null): string | null => (p ? p.replace(/\\/g, '/') : p)

// Path is the durable navigation key across a workspace replacement (ADR-0038 §3.2):
// setWorkspaceRoot clears the store, so an id captured before a link click goes stale.
async function activeDocPath(page: Page): Promise<string | null> {
  return page
    .evaluate(async () => {
      const w = window as any
      const id = w.__uiStore.getState().activeDocumentId as string | null
      if (!id) return null
      const doc = await window.api.documents.get(id)
      return doc?.filePath ?? null
    })
    .then(norm)
}
