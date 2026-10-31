// Export dialog e2e — PLAN C20 补 ⑦ (E12) and C20 补 ⑤ (E11, second half).
//
// E11: "Export HTML" is ONE action with ONE implementation. Clicking the preview bar's export
// button must open the very same dialog as the global bar's button — a second implementation
// would be exactly the drift ADR-0024 §10 trade-off 46 forbids. The "only one export button on
// screen" rule (the entry point follows the preview's visibility) is asserted too.
//
// E12: while the document has not finished rendering, the export must be DISABLED (and say so)
// instead of writing the previous document's cached HTML or showing an error the user cannot
// act on.
import { test, expect, type Locator, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'

interface ShadowProbe {
  hasMarkdownBody: boolean
  theme: string | null
  containerPadding: string | null
  preBg: string | null
  preRadius: string | null
  keywordColor: string | null
  hasExportCss: boolean
  hasFontFace: boolean
}

/** Read the export preview's shadow tree — the thing the feature exists to prove. */
async function probeShadow(host: Locator): Promise<ShadowProbe | null> {
  return host.evaluate((el) => {
    const root = (el as HTMLElement).shadowRoot
    if (!root) return null
    const md = root.querySelector('.markdown-body') as HTMLElement | null
    const container = root.querySelector('.export-preview-container') as HTMLElement | null
    const pre = root.querySelector('pre') as HTMLElement | null
    const keyword = root.querySelector('.hljs-keyword') as HTMLElement | null
    const styles = Array.from(root.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n')
    return {
      hasMarkdownBody: !!md,
      theme: md?.getAttribute('data-theme') ?? null,
      containerPadding: container ? getComputedStyle(container).paddingTop : null,
      preBg: pre ? getComputedStyle(pre).backgroundColor : null,
      preRadius: pre ? getComputedStyle(pre).borderRadius : null,
      keywordColor: keyword ? getComputedStyle(keyword).color : null,
      hasExportCss: styles.includes('.markdown-body pre.hljs'),
      hasFontFace: styles.includes('@font-face'),
    }
  })
}

/** Read the app's own preview, for the parity comparison. */
async function probeAppPreview(pane: Locator): Promise<{
  preBg: string
  preRadius: string
  keywordColor: string | null
}> {
  return pane.evaluate((el) => {
    const pre = el.querySelector('pre') as HTMLElement
    const keyword = el.querySelector('.hljs-keyword') as HTMLElement | null
    return {
      preBg: getComputedStyle(pre).backgroundColor,
      preRadius: getComputedStyle(pre).borderRadius,
      keywordColor: keyword ? getComputedStyle(keyword).color : null,
    }
  })
}

/** A document with a highlighted code block, split view, export dialog open, preview painted. */
async function openExportPreview(
  page: Page,
): Promise<{ dialog: Locator; host: Locator; appPreview: Locator }> {
  await page.getByTestId('new-document-btn').click()
  await expect(page.locator('.cm-content')).toBeVisible()
  await page.locator('.cm-content').click()
  await page.keyboard.type('# Heading\n\n```js\nconst x = 1\n```\n')

  // Split view ⇒ the app preview (the pane) and the export preview (the dialog) can be
  // compared side by side.
  await page.getByTestId('view-split').click()
  const appPreview = page.locator('.markdown-preview')
  await expect(appPreview).toBeVisible()
  await expect(appPreview.locator('pre')).toBeVisible()

  await page.getByTestId('export-btn').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const host = dialog.getByTestId('export-preview-host')
  await expect(host).toBeVisible()
  await expect.poll(async () => (await probeShadow(host))?.hasMarkdownBody ?? false).toBe(true)
  return { dialog, host, appPreview }
}

test.describe('export dialog', () => {
  let handle: AppHandle

  test.beforeEach(async () => {
    handle = await launchApp()
  })

  test.afterEach(async () => {
    await closeApp(handle)
  })

  test('the preview bar opens the same export dialog, and only one export button is on screen', async () => {
    const { page } = handle
    await waitForAppReady(page)

    await page.getByTestId('new-document-btn').click()
    await expect(page.locator('.cm-content')).toBeVisible()

    // Split view ⇒ the preview is visible ⇒ the export entry point lives on the PREVIEW bar.
    await page.getByTestId('view-split').click()
    await expect(page.locator('.markdown-preview')).toBeVisible()

    // Exactly ONE export button on screen (the global bar's is hidden while the preview shows).
    await expect(page.getByTestId('export-btn')).toHaveCount(1)

    await page.getByTestId('export-btn').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // The same dialog as the global bar's entry point: same title, same target-path field.
    await expect(dialog.getByText('Export as HTML')).toBeVisible()
    await expect(dialog.locator('input[readonly]')).toBeVisible()
  })

  test('the export button is disabled while the document is still rendering (E12)', async () => {
    const { page } = handle
    await waitForAppReady(page)

    await page.getByTestId('new-document-btn').click()
    await expect(page.locator('.cm-content')).toBeVisible()

    // Simulate the "rendering in flight" window deterministically: the store flag is what the
    // preview flips while a document switch or a pending parse is in progress.
    await page.evaluate(() => {
      ;(window as any).__uiStore.getState().setExportReady(false)
    })

    await page.getByTestId('export-btn').first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    const exportBtn = dialog.getByRole('button', { name: 'Preparing…' })
    await expect(exportBtn).toBeDisabled()

    // Once the document has rendered, the same button becomes actionable.
    await page.evaluate(() => {
      ;(window as any).__uiStore.getState().setExportReady(true)
    })
    await expect(dialog.getByRole('button', { name: 'Export' })).toBeEnabled()
  })

  test('the export preview renders the EXPORT document in a shadow root (E13)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const { host, appPreview } = await openExportPreview(page)

    const shadow = await probeShadow(host)

    expect(shadow, 'the preview must live in a shadow root').not.toBeNull()
    expect(shadow!.hasMarkdownBody).toBe(true)
    expect(shadow!.theme).toBe('light')
    // The export's own stylesheet is inlined (the shared .markdown-body overrides).
    expect(shadow!.hasExportCss).toBe(true)
    // S2: `body` does not match inside a shadow root, so the export's body-level padding has to
    // be applied to the preview container instead.
    expect(shadow!.containerPadding).toBe('24px')
    // S1: a shadow root does not register fonts, so the @font-face rules live in the HOST
    // document instead of the shadow root.
    expect(shadow!.hasFontFace).toBe(false)
    const hostFonts = await page.evaluate(() => ({
      declared: (
        document.getElementById('markflow-export-preview-fonts')?.textContent ?? ''
      ).includes('@font-face'),
      // FontFaceSet lists every DECLARED face, whether or not it has been loaded yet — so this
      // proves the KaTeX faces are really registered with the host document, not just present
      // as dead CSS text.
      katexFaces: Array.from(document.fonts).filter((f) => /KaTeX/i.test(f.family)).length,
    }))
    expect(hostFonts.declared).toBe(true)
    expect(
      hostFonts.katexFaces,
      'the KaTeX faces must be registered in the host document',
    ).toBeGreaterThan(10)

    // C33 parity, now asserted through the preview: the export preview and the app preview
    // must agree on the code-block box and on the syntax colors.
    const app = await probeAppPreview(appPreview)
    expect(shadow!.preBg).toBe(app.preBg)
    expect(shadow!.preRadius).toBe(app.preRadius)
    expect(shadow!.keywordColor).toBe(app.keywordColor)
  })

  test('the export preview follows the dark theme (E13)', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // C20 ⑨ W1: the preview follows the theme the EXPORT will use, not the app's own styling.
    await page.evaluate(() => (window as any).__uiStore.getState().setTheme('dark'))
    const { host, appPreview } = await openExportPreview(page)

    const shadow = await probeShadow(host)
    expect(shadow, 'the preview must live in a shadow root').not.toBeNull()
    expect(shadow!.theme).toBe('dark')

    // The dark code-block box and the dark syntax palette must match the app preview exactly
    // (C33's invariant, now proven through the export preview).
    const app = await probeAppPreview(appPreview)
    expect(shadow!.preBg).toBe(app.preBg)
    expect(shadow!.preRadius).toBe(app.preRadius)
    expect(shadow!.keywordColor).toBe(app.keywordColor)
    // Anti-vacuity: the light palette puts keywords at a near-black colour and the dark palette
    // at #ff7b72 (markdownExport.css, dark hljs block), so this value also proves the DARK sheet
    // was applied rather than merely "some" colour.
    expect(shadow!.keywordColor).toBe('rgb(255, 123, 114)')
  })
})
