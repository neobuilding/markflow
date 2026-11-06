import { test, expect } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { readTooltipColors } from '../helpers/tooltip'

// Locks the tooltip's INVERTED token colours (design fig 02 + PLAN C22): the bubble takes
// --color-text-primary and the text takes --color-bg, with NO visible border (border == fill).
// This also guards C22 — the bubble must be token-only, never an inline hex again.
//
// NOTE: like every other e2e-app spec this drives the REAL Electron app via launchApp() —
// it must NOT use the default Playwright `page` fixture, which would try to launch a real
// chromium browser (the chromium_headless_shell that this suite never needs).
test.describe('tooltip — inverted token colours', () => {
  let handle: AppHandle
  test.beforeEach(async () => {
    handle = await launchApp()
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  test('light theme: navy bubble, white text, no visible border', async () => {
    const { page } = handle
    await waitForAppReady(page)
    // The hover and the colour read are ONE step: a bubble that unmounts mid-read (a re-render
    // replaces its trigger) would otherwise yield a value read from a detached node.
    const { bg, fg, border } = await readTooltipColors(page, 'editor-goto-file-btn')
    // light --color-text-primary = rgb(31,41,55); white = rgb(255,255,255)
    expect(bg).toBe('rgb(31, 41, 55)')
    expect(fg).toBe('rgb(255, 255, 255)')
    expect(border).toBe(bg)
  })

  test('dark theme: light bubble, dark text', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await page.evaluate(() => (window as any).__uiStore.getState().setTheme('dark'))
    // Wait for the theme to actually LAND before hovering: the class is toggled on <html> from an
    // effect, and the resulting relayout can move the trigger out from under the pointer — the
    // pointer then never enters a trigger and no tooltip opens at all.
    await expect(page.locator('html')).toHaveClass(/dark/)
    const { bg, fg } = await readTooltipColors(page, 'editor-goto-file-btn')
    // dark --color-text-primary = rgb(230,237,243); --color-bg = rgb(15,20,25)
    expect(bg).toBe('rgb(230, 237, 243)')
    expect(fg).toBe('rgb(15, 20, 25)')
  })
})
