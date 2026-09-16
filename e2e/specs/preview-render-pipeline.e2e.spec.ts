import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Plan 01 stage 1 (preview render-pipeline refactor) — real-renderer acceptance.
//
// The unit suite proves the pipeline and the DOM patcher in isolation, but only the real
// Electron renderer proves the END-TO-END shape produced by markdown-it → sanitize → patch:
//
//   R6 — every top-level block carries a `data-line` source mapping
//   P8 — the preview <article> holds the content DIRECTLY (the old SafeHtml wrapper <div> is gone)
//
// (R4 incremental patch / R5 single sanitization are behavioural and are covered by the unit
// suite; the existing preview e2e specs — mermaid/katex/context-menu/save-export — would fail
// loudly if the DOM shape or the mermaid baking broke, e.g. this suite is what catches a bad
// `data-mermaid-slot` placeholder shape that stops the SVG from being baked in.)
test.describe('preview render pipeline (Plan 01 stage 1)', () => {
  let handle: AppHandle
  let scratch: string

  test.beforeEach(async () => {
    handle = await launchApp()
    scratch = mkdtempSync(join(tmpdir(), 'markflow-e2e-'))
  })

  test.afterEach(async () => {
    await closeApp(handle)
  })

  // Write the document to disk and open it through the real import IPC + UI store, so the
  // preview renders the real pipeline output (same approach as mermaid-preview.e2e.spec.ts).
  async function openDoc(page: Page, content: string): Promise<void> {
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
  }

  test('top-level blocks carry a data-line source mapping (R6)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await openDoc(page, '# Heading\n\nA paragraph.\n')

    await expect(page.locator('.markdown-preview h1').first()).toHaveAttribute('data-line', /\d+/)
    await expect(page.locator('.markdown-preview p').first()).toHaveAttribute('data-line', /\d+/)
  })

  test('the <article> holds content directly — no wrapper div (P8)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await openDoc(page, '# Heading\n\nA paragraph.\n')

    // A direct-child (`>`) selector only matches when the block is NOT nested inside a wrapper
    // div — the exact extra layer the removed SafeHtml component used to introduce.
    await expect(page.locator('article.markdown-preview > h1').first()).toBeVisible()
    await expect(page.locator('article.markdown-preview > p').first()).toBeVisible()
  })
})
