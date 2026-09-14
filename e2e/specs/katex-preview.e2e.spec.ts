import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Guards the runtime risk of the KaTeX font prune (ADR-0015): `scripts/prune-fonts.ts`
// deletes 38 `.woff`/`.ttf` files from the renderer bundle, and the only reason that is
// safe is that every @font-face still resolves to a `.woff2` that is actually shipped.
// A missing font degrades SILENTLY (the browser falls back, no error is logged), so this
// cannot be asserted from the DOM — but the worst failure mode CAN: if the prune ever
// removed a format the CSS really needs, or if katex stopped reaching the bundle, the
// formula would not render at all. This spec locks that end to end in the real app.
test.describe('katex preview', () => {
  let handle: AppHandle
  let scratch: string

  test.beforeEach(async () => {
    handle = await launchApp()
    scratch = mkdtempSync(join(tmpdir(), 'markflow-e2e-'))
  })

  test.afterEach(async () => {
    await closeApp(handle)
  })

  async function openDoc(page: Page, content: string): Promise<void> {
    const file = join(scratch, `math-${Date.now()}.md`)
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
    await expect(page.locator('.markdown-preview')).toBeVisible()
  }

  test('renders inline and display math through the pruned KaTeX font set', async () => {
    const { page } = handle
    await waitForAppReady(page)

    await openDoc(
      page,
      ['# Math', '', 'Inline $E=mc^2$ and display:', '', '$$\\int_0^1 x^2\\,dx$$', ''].join('\n'),
    )

    // Both the inline and the display formula must produce real KaTeX markup.
    const katex = page.locator('.markdown-preview .katex')
    await expect(katex.first()).toBeVisible({ timeout: 30_000 })
    expect(await katex.count()).toBeGreaterThanOrEqual(2)

    // KaTeX's MathML accessibility layer carries the TeX source; finding it proves the
    // katex engine actually ran (not just that a placeholder survived sanitization).
    const tex = await page
      .locator('.markdown-preview .katex annotation[encoding="application/x-tex"]')
      .first()
      .textContent()
    expect((tex ?? '').replace(/\s+/g, '')).toContain('mc')

    // And the pipeline did not fall back to its error message.
    await expect(page.locator('.markdown-preview')).not.toContainText('Error rendering preview')
  })
})
