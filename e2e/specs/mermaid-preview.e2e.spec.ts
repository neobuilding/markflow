import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Mermaid is dynamically imported on first use (`getMermaid()` in MarkdownPreview.tsx)
// so the ~2.5 MB library stays out of the initial chunk. Unit tests can't prove that
// works: they `vi.mock('mermaid')`, so the dynamic import ALWAYS resolves. Only the
// real Electron app exercises the actual chunk fetch — which is exactly where a
// `file://` + relative-base misconfiguration would silently break diagrams.
test.describe('mermaid preview', () => {
  let handle: AppHandle
  let scratch: string

  test.beforeEach(async () => {
    handle = await launchApp()
    scratch = mkdtempSync(join(tmpdir(), 'markflow-e2e-'))
  })

  test.afterEach(async () => {
    await closeApp(handle)
  })

  // Write the document to disk and open it through the same import IPC the
  // Open File dialog uses, then activate it via the REAL UI store. Deterministic:
  // avoids CodeMirror auto-closing fences while typing.
  async function openDoc(page: Page, content: string): Promise<string> {
    const file = join(scratch, `doc-${Date.now()}.md`)
    writeFileSync(file, content, 'utf-8')
    const id = await page.evaluate(
      (f) => window.api.documents.import(f).then((d: any) => d.id),
      file,
    )
    expect(id).toBeTruthy()
    await page.evaluate((docId) => {
      const w = window as any
      w.__uiStore.getState().setActiveDocumentId(docId)
      w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
    }, id)
    await expect(page.locator('.cm-content')).toBeVisible()
    await expect(page.locator('.markdown-preview')).toBeVisible()
    return id
  }

  test('renders a mermaid diagram through the lazily imported mermaid chunk', async () => {
    const { page } = handle
    await waitForAppReady(page)

    await openDoc(
      page,
      ['# Diagram', '', '```mermaid', 'graph TD', '  A[Start] --> B[End]', '```', ''].join('\n'),
    )

    // The rendered SVG lands inside the slot wrapper. Seeing it proves the real
    // mermaid module was fetched, initialised and executed in the renderer.
    const wrapper = page.locator('[data-mermaid-slot="0"]')
    await expect(wrapper.locator('svg')).toBeVisible({ timeout: 30_000 })
    // No failure placeholder: the diagram rendered for real.
    await expect(page.locator('.mermaid-skeleton')).toHaveCount(0)
    // The wrapper keeps the raw source for "Copy diagram source" (URI-encoded, because
    // a decoded `-->` would make DOMPurify drop the attribute). Its presence proves the
    // lazy mermaid import, the baking step and the sanitization gate all ran for real.
    const src = await wrapper.getAttribute('data-mermaid-source')
    expect(src).toBeTruthy()
    expect(decodeURIComponent(src as string)).toContain('graph TD')
  })

  test('a malformed diagram degrades to the skeleton without breaking the preview', async () => {
    const { page } = handle
    await waitForAppReady(page)

    await openDoc(
      page,
      ['# Diagram', '', '```mermaid', 'graph TD', '  A[[[unclosed', '```', ''].join('\n'),
    )

    // The failed render is downgraded to a placeholder rather than killing the
    // preview; the rest of the document still renders.
    await expect(page.locator('.mermaid-skeleton')).toHaveCount(1, { timeout: 30_000 })
    await expect(page.locator('.markdown-preview h1')).toContainText('Diagram')
  })
})
