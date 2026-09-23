// ADR 0020 — a formula's bitmap is an explicit, per-formula action: right-click → "Copy formula
// as image". Rich-text copy keeps MathML as the carrier (Word / OneNote turn it into a real,
// editable equation), but targets that render neither MathML nor KaTeX's CSS show the formula as
// three concatenated texts (F23) — and one clipboard cannot tell the targets apart.
//
// Why this must be an e2e: the path inlines KaTeX's CSS + woff2 fonts as `data:` URLs inside an
// SVG `<foreignObject>` and rasterizes it with `<img>`/`<canvas>`. None of that runs under jsdom,
// and it fails SILENTLY — an `<img>` that cannot parse the SVG just fires `onerror` and nothing is
// copied (the same failure class as the `blob:` CSP bug, F14). The unit tests cover the assembly;
// only a real browser can prove a bitmap comes out.
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir } from '../helpers/temp'

const MATH_DOC = ['# Math', '', 'Inline $E = mc^2$ here.', '', '$$\\int_0^1 x^2\\,dx$$', ''].join(
  '\n',
)

test.describe('copy a formula as an image (ADR 0020)', () => {
  let handle: AppHandle
  let scratch: string

  test.beforeEach(async () => {
    handle = await launchApp()
    scratch = mkTempDir('markflow-formula-')
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  async function openMathDoc(page: Page): Promise<void> {
    const file = join(scratch, `formula-${Date.now()}.md`)
    writeFileSync(file, MATH_DOC, 'utf-8')
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

  const clearClipboard = () => handle.electronApp.evaluate(({ clipboard }) => clipboard.clear())

  // Read the bitmap back out of the REAL system clipboard (main process), plus an "ink" count:
  // an all-white bitmap — fonts or CSS missing — is exactly how this feature fails silently.
  // Electron 44 dropped the synchronous `clipboard.readImage`, so the PNG blob is read with the
  // async Clipboard API and decoded with `nativeImage`.
  const readClipImage = () =>
    handle.electronApp.evaluate(async ({ clipboard, nativeImage }) => {
      const items = await clipboard.read()
      const item = items.find((entry) => entry.types.includes('image/png'))
      if (!item) return { width: 0, height: 0, bytes: 0, empty: true, ink: 0 }
      const blob = (await item.getType('image/png')) as Blob
      const buf = Buffer.from(await blob.arrayBuffer())
      const img = nativeImage.createFromBuffer(buf)
      const size = img.getSize()
      const bmp = img.toBitmap()
      let ink = 0
      for (let i = 0; i + 2 < bmp.length; i += 4) {
        // Channel order is platform-dependent (RGBA/BGRA); "any channel is dark" is agnostic.
        if (bmp[i] < 200 || bmp[i + 1] < 200 || bmp[i + 2] < 200) ink += 1
      }
      return {
        width: size.width,
        height: size.height,
        bytes: buf.length,
        empty: img.isEmpty(),
        ink,
      }
    })

  test('right-click an inline formula → Copy formula as image lands a real bitmap', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await openMathDoc(page)
    await page.getByTestId('view-preview').click()
    const article = page.locator('.markdown-preview')
    await expect(article).toBeVisible()

    const formula = page.locator('.markdown-preview .katex').first()
    await expect(formula).toBeVisible({ timeout: 30_000 })

    await clearClipboard()
    // A real right-click lands on the <p> for an inline formula (Playwright's hit test reports
    // "p intercepts pointer events"), so dispatch the contextmenu event on the formula itself —
    // same event, same React handler, same coordinates.
    await formula.evaluate((el) => {
      const r = el.getBoundingClientRect()
      el.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
        }),
      )
    })
    const item = page.getByTestId('preview-copy-formula-image')
    await expect(item).toBeVisible()
    await item.click()

    // Rasterization is async (fetch fonts → build SVG → <img> → canvas).
    await expect
      .poll(async () => (await readClipImage()).bytes, { timeout: 30_000 })
      .toBeGreaterThan(0)
    const img = await readClipImage()
    expect(img.empty).toBe(false)

    // 2× the formula's on-screen box plus 8px padding per side (FORMULA_SCALE / FORMULA_PADDING) —
    // a bare clipboard PNG carries no display size, so the pixel size IS the pasted size.
    const rect = await page.evaluate(() => {
      const el = document.querySelector('.markdown-preview .katex')
      if (!el) return { width: 0, height: 0 }
      const r = el.getBoundingClientRect()
      return { width: r.width, height: r.height }
    })
    expect(rect.width).toBeGreaterThan(10)
    const expectedWidth = (Math.ceil(rect.width) + 16) * 2
    expect(img.width).toBeGreaterThanOrEqual(expectedWidth - 4)
    expect(img.width).toBeLessThanOrEqual(expectedWidth + 4)

    // Not a blank canvas, and not a solid block either: the glyphs really rendered, which is what
    // breaks when the KaTeX CSS or its woff2 faces fail to reach the SVG.
    expect(img.ink).toBeGreaterThan(50)
    expect(img.ink).toBeLessThan(img.width * img.height * 0.6)
  })

  test('a block formula offers the same item from its container', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await openMathDoc(page)
    await page.getByTestId('view-preview').click()
    const article = page.locator('.markdown-preview')
    await expect(article).toBeVisible()

    const display = page.locator('.markdown-preview .katex-display')
    await expect(display).toBeVisible({ timeout: 30_000 })

    await clearClipboard()
    await display.click({ button: 'right' })
    const item = page.getByTestId('preview-copy-formula-image')
    await expect(item).toBeVisible()
    await item.click()

    await expect
      .poll(async () => (await readClipImage()).bytes, { timeout: 30_000 })
      .toBeGreaterThan(0)
    const img = await readClipImage()
    expect(img.empty).toBe(false)
    expect(img.ink).toBeGreaterThan(50)
    // The bitmap must be the TIGHT content box, not the full-width block: a block formula's
    // `.katex` spans the whole preview (≈2257px), so an un-tightened copy would be ~4500px wide
    // with the glyphs floating in the middle — exactly the "huge left/right whitespace" report.
    expect(img.width).toBeGreaterThan(120)
    expect(img.width).toBeLessThan(600)
  })

  // The menu item must NOT turn the ordinary rich-text copy into a bitmap: MathML stays the
  // carrier there, so a formula pastes into Word as an editable equation, not a picture.
  test('the plain Copy of a formula still carries MathML, not a picture', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await openMathDoc(page)
    await page.getByTestId('view-preview').click()
    const article = page.locator('.markdown-preview')
    await expect(article).toBeVisible()
    await expect(page.locator('.markdown-preview .katex').first()).toBeVisible({ timeout: 30_000 })

    const readClipHtml = () =>
      handle.electronApp.evaluate(async ({ clipboard }) => {
        const items = await clipboard.read()
        const item = items[0]
        if (!item || !item.types.includes('text/html')) return ''
        const blob = (await item.getType('text/html')) as Blob
        return await blob.text()
      })

    let html = ''
    await expect
      .poll(
        async () => {
          await article.locator('p').first().click({ button: 'right' })
          await page.getByTestId('preview-copy').click()
          html = await readClipHtml()
          return /<math[\s>]/i.test(html)
        },
        { timeout: 25_000 },
      )
      .toBe(true)
    // …and no formula was swapped for a bitmap by the image action.
    expect(html).not.toMatch(/<img[^>]+src="data:image\/png/i)
  })
})
