import { expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { test } from '../helpers/fixtures'

// Surface-hierarchy guard, locked against the design image (fig 02 split-view-toolbar-placement) and
// ADR-0024 §1.1. The design image uses a TWO-TIER bar tint:
//   - GLOBAL bar (top, file commands)        = #EDF2F9 = --color-surface-overlay (clearly blue-gray)
//   - PANE bars (editor / preview toolbars)  = #F4F7FB ≈ --color-bg       (subtle, near-white)
//   - sidebar content PANEL                  = #FFFFFF = --color-surface   (white)
// This locks the fix for the sidebar/toolbar background inversion that the earlier "illustration is
// deprecated" reviews missed, and prevents regressing to either extreme (all-white or all-overlay).
//
// Colors are the light-theme resolved values (the app defaults to light, see store/ui.ts).
const SURFACE = 'rgb(255, 255, 255)' // --color-surface  (#ffffff)
const OVERLAY = 'rgb(237, 242, 249)' // --color-surface-overlay (#edf2f9)
const BASE = 'rgb(245, 247, 251)' // --color-bg (#f5f7fb) ≈ design #F4F7FB pane-bar tint

async function bg(page: Page, selector: string): Promise<string> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) return ''
    return getComputedStyle(el).backgroundColor
  }, selector)
}

test.describe('surface hierarchy: white sidebar panel, two-tier blue-gray bars', () => {
  let handle: AppHandle
  test.beforeEach(async () => {
    handle = await launchApp()
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  test('sidebar content panel is white (surface) and the activity bar is blue-gray (overlay)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const panel = page.locator('[role="tabpanel"]')
    await expect(panel).toBeVisible()
    // The sidebar panel is a panel → white surface, NOT the base --color-bg (blue-gray).
    await expect.poll(() => bg(page, '[role="tabpanel"]')).toBe(SURFACE)
    // The 48px activity rail is a raised bar → overlay blue-gray.
    await expect.poll(() => bg(page, '[role="tablist"]')).toBe(OVERLAY)
  })

  test('global bar is clearly blue-gray (overlay) while pane bars stay subtle (base), per design fig 02', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await page.getByTestId('new-document-btn').click()
    await expect(page.locator('.cm-content')).toBeVisible()
    await page.getByTestId('view-split').click()
    await expect(page.getByTestId('editor-pane')).toBeVisible()
    await expect(page.getByTestId('preview-pane')).toBeVisible()

    // GLOBAL bar (top, file commands) = the clearly blue-gray overlay tint.
    await expect.poll(() => bg(page, '[data-testid="global-bar"]')).toBe(OVERLAY)
    // PANE bars (editor / preview toolbars) = the SUBTLE base tint, NOT white, NOT the overlay tint.
    await expect.poll(() => bg(page, '[data-testid="editor-pane-bar"]')).toBe(BASE)
    await expect.poll(() => bg(page, '[data-testid="preview-pane-bar"]')).toBe(BASE)

    // Design's two-tier distinction: the global bar is MORE saturated than the pane bars.
    await expect.poll(() => bg(page, '[data-testid="global-bar"]')).not.toBe(BASE)
    // Regression guards: no bar may be the white panel surface.
    await expect.poll(() => bg(page, '[data-testid="global-bar"]')).not.toBe(SURFACE)
    await expect.poll(() => bg(page, '[data-testid="editor-pane-bar"]')).not.toBe(SURFACE)
    await expect.poll(() => bg(page, '[data-testid="preview-pane-bar"]')).not.toBe(SURFACE)
  })
})
