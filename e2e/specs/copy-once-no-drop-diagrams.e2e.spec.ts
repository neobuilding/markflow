// Regression (2026-09-22) for the user-reported "first copy drops mermaid diagrams" bug.
//
// Root cause this locks in: the `copy` event is synchronous, but the diagrams' PNG forms are
// produced asynchronously. The complete bake (SVG + PNG rasterization) used to be a fire-and-forget
// background job, so a copy fired within the first second after opening — before the PNG pass had
// run — shipped a payload with empty diagram slots, and the four target apps (Word / OneNote /
// Youdao / Obsidian) silently dropped them. The diagrams reappeared only on a SECOND copy, once the
// bake had settled (the user's manual observation: scroll-to-reveal → copy → no loss).
//
// Fix (plan-preview-refactor D): the bake now awaits the PNG pass before declaring itself complete,
// and the synchronous `copy` handler — when it finds the bake not ready — defers, finishes the bake,
// REBUILDS the payload and re-fires the native copy. So a SINGLE user action always yields a
// complete payload.
//
// This test drives the exact user flow: open the 4-diagram demo, go to the preview, press
// Ctrl+A + Ctrl+C ONCE (no waiting for the diagrams to render, unlike the menu-path demo test which
// pre-warms by asserting the first <svg> is visible), then WAIT — reading the clipboard only, never
// re-pressing — until all four diagrams arrive as PNGs.
//
// Note: whether a given run lands in the cold window is timing-dependent, so a green here is not by
// itself proof the retry ran. The deterministic guarantee for the mechanism lives in the unit tests
// (`previewCopy.test.ts` → "cold-cache copy retry"); this spec is the end-to-end user-facing guard
// that a single copy never leaves the clipboard short.
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir } from '../helpers/temp'

test.describe('preview: a single copy lands every diagram (no copy-once drop)', () => {
  let handle: AppHandle
  let scratch: string

  test.beforeEach(async () => {
    handle = await launchApp()
    scratch = mkTempDir('markflow-copy-once-')
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  async function openDoc(page: Page, content: string): Promise<string> {
    const file = join(scratch, `doc-${Date.now()}-${Math.random().toString(36).slice(2)}.md`)
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

  test('Ctrl+A + Ctrl+C pressed ONCE lands all 4 diagrams as PNGs', async () => {
    const { page, electronApp } = handle
    await waitForAppReady(page)
    // The demo fixture is a self-contained English copy of examples/demo.en.md with 4 mermaid
    // diagrams (flowchart / sequence / gantt / pie): e2e/fixtures/preview-render-pipeline/diagrams.md.
    await openDoc(
      page,
      readFileSync(join('e2e', 'fixtures', 'preview-render-pipeline', 'diagrams.md'), 'utf-8'),
    )
    // Go to the preview but do NOT wait for the first diagram's <svg>: staying cold is the point —
    // this is the "open the doc and copy straight away" flow that used to drop diagrams.
    await page.getByTestId('view-preview').click()
    const article = page.locator('.markdown-preview')
    await expect(article).toBeVisible()

    const readClip = async (): Promise<string> =>
      electronApp.evaluate(async ({ clipboard }) => {
        const items = await clipboard.read()
        const item = items[0]
        if (!item || !item.types.includes('text/html')) return ''
        const blob = (await item.getType('text/html')) as Blob
        return await blob.text()
      })

    // The real user flow: focus the preview, select-all, copy — EXACTLY ONCE. No poll/retry; this
    // single action is what used to come out short.
    await article.locator('p').first().click()
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Control+c')

    // Now WAIT (reading only — never re-pressing) for all four diagrams to arrive as PNGs. If the
    // press was cold, the cold-cache retry re-fires the copy after the bake completes, so the one
    // user action still produces a complete payload; if it was warm, it is immediate.
    let html = ''
    await expect
      .poll(
        async () => {
          html = await readClip()
          return (html.match(/<img[^>]+alt="diagram"/gi) || []).length
        },
        { timeout: 30_000 },
      )
      .toBe(4)

    // Every diagram arrived as a PNG — none left as an empty placeholder.
    expect(html).toMatch(/<img[^>]+src="data:image\/png;base64,/i)
    expect(html).not.toContain('data-mermaid-slot')
  })
})
