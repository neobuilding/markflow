// E9 — visual regression, scoped to the CHROME ONLY.
//
// Why so narrow: pixel baselines are the most expensive kind of test to keep green. They break on
// font rasterisation, GPU/driver changes and OS defaults, and this repo's e2e runs on both Windows
// (dev) and Linux (CI). So the baseline covers the toolbar rows — their appearance is pure CSS
// (borders, radii, hit areas, icon size, token colours) and they carry no body text, which is
// exactly the part the C13/C23/C33 work keeps changing and re-breaking.
//
// Deliberately NOT covered: the status bar (its content is mostly dynamic — file path, word count,
// save state, encoding — so masking it leaves nothing worth comparing) and any pane body (that is
// content rendering, owned by export-parity / katex / mermaid / context-menu instead).
//
// Baselines are generated on ONE platform and skipped everywhere else. Playwright already suffixes
// snapshot files with the platform name, so adding a Linux baseline later needs no change here:
// run the spec with `--update-snapshots` on that platform once, then widen BASELINE_PLATFORMS.
//
// Re-capture record: the editor (light+dark) and preview bar baselines were re-captured on
// 2026-11-04 with the progressive-overflow rework. Each re-capture was measured against the
// committed PNG (340 / 300 / 22 pixels, all over the 20px budget); only the light editor diff was
// localised further (to the trailing find/replace/undo/redo/read-only segment). The full record,
// including what was NOT established, is docs/adr/0031-ui-round-3-shortcuts-overflow-and-menu.md
// §5.1 — a re-capture whose cause is not understood must be REPORTED, not silently merged.
import { test, expect } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { VIEWPORTS } from '../helpers/viewports'

const BASELINE_PLATFORMS = ['win32']

/**
 * Absolute pixel budget, NOT a ratio.
 *
 * A ratio was tried first and it silently defeated the whole point: these bars are ~1000px wide, so
 * a 2% budget absorbed a real regression (every icon button growing from 32px to 36px moved well
 * under 2% of the pixels) and the baseline stayed green. Rendering here is deterministic on one
 * platform, so the only tolerance needed is for sub-pixel AA jitter — a handful of pixels.
 */
const MAX_DIFF_PIXELS = 20

test.describe('chrome visual baseline (E9)', () => {
  let handle: AppHandle | undefined

  test.beforeAll(async () => {
    test.skip(
      !BASELINE_PLATFORMS.includes(process.platform),
      `baselines exist for ${BASELINE_PLATFORMS.join(', ')} only`,
    )
    handle = await launchApp()
    // The baselines are pixel-exact, so the environment has to be pinned as well: they were
    // captured in a 2560px window (the global bar is 2272px = 2560 - 288, a pane bar one column of
    // that). Without this the spec inherited whatever width the host monitor maximized to, so it
    // failed on every machine that was not the one that captured the images. The named environment
    // and the committed PNGs are kept in step by e2e/guards/viewports.test.ts.
    await handle.page.setViewportSize(VIEWPORTS.baseline)
  })

  test.afterAll(async () => {
    if (handle) await closeApp(handle)
  })

  async function openSplit(page: AppHandle['page']): Promise<void> {
    // Only ONE unsaved draft may exist at a time (the New Draft control is disabled once one is
    // open), so reuse the document that is already open instead of asking for a second one. The
    // pane bars show the document title, which is the same "Untitled" either way.
    if ((await page.locator('.cm-content').count()) === 0) {
      await page.getByTestId('new-document-btn').click()
      await expect(page.locator('.cm-content')).toBeVisible()
    }
    await page.getByTestId('view-split').click()
    await expect(page.getByTestId('preview-pane-bar')).toBeVisible()
    await expect(page.getByTestId('editor-pane-bar')).toBeVisible()
  }

  test('the toolbar rows keep their shape (light)', async () => {
    const { page } = handle!
    await waitForAppReady(page)
    await openSplit(page)

    // Playwright already hides the caret and finishes CSS transitions before capturing, so a
    // `transition-colors` hover/active state cannot land mid-flight.
    await expect(page.getByTestId('global-bar')).toHaveScreenshot('global-bar.png', {
      maxDiffPixels: MAX_DIFF_PIXELS,
    })
    await expect(page.getByTestId('editor-pane-bar')).toHaveScreenshot('editor-pane-bar.png', {
      maxDiffPixels: MAX_DIFF_PIXELS,
    })
    await expect(page.getByTestId('preview-pane-bar')).toHaveScreenshot('preview-pane-bar.png', {
      maxDiffPixels: MAX_DIFF_PIXELS,
    })
  })

  test('the pane bar keeps its shape (dark)', async () => {
    const { page } = handle!
    await waitForAppReady(page)
    await openSplit(page)
    await page.evaluate(() => (window as any).__uiStore.getState().setTheme('dark'))
    await expect(page.getByTestId('editor-pane-bar')).toHaveScreenshot('editor-pane-bar-dark.png', {
      maxDiffPixels: MAX_DIFF_PIXELS,
    })
  })
})
