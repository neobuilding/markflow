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
import { test, expect } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'

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
  })

  test.afterAll(async () => {
    if (handle) await closeApp(handle)
  })

  async function openSplit(page: AppHandle['page']): Promise<void> {
    await page.getByTestId('new-document-btn').click()
    await expect(page.locator('.cm-content')).toBeVisible()
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
