// Font-floor e2e (PLAN C13)
// The `2xs` token is the app-wide floor: 11px. ADR-0024 §5.1 makes it normative, and C13 raised
// it from 10px — a GLOBAL change (every `text-2xs` consumer moved by 1px), which is exactly the
// kind of change that needs a regression guard rather than a screenshot.
//
// This spec is the automated stand-in for C13's "逐点截图" deliverable: it walks the rendered UI
// and fails if ANY visible text renders below the floor. A screenshot proves one moment; this
// proves every element, in the app's real cascade, forever.
//
// Scope: the app chrome. The rendered markdown preview is USER content (github-markdown-css
// owns its type scale), so it is excluded — the floor is an app-UI rule.
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'

const FLOOR_PX = 11

interface Sweep {
  /** Every visible text node below the floor. */
  tooSmall: Array<{ text: string; px: number; where: string }>
  /** How many visible text nodes were inspected (guards against a vacuous pass). */
  inspected: number
}

/**
 * Walk the rendered DOM and report every visible text node whose computed font-size is below
 * the floor. One pass, one answer — the two numbers must not drift apart.
 */
async function sweepFontSizes(page: Page): Promise<Sweep> {
  return page.evaluate((floor) => {
    const tooSmall: Array<{ text: string; px: number; where: string }> = []
    let inspected = 0
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      // The rendered markdown preview is USER content — github-markdown-css owns its scale.
      if (el.closest('article.markdown-preview, .markdown-body, .cm-content')) continue
      const ownText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => (n.textContent ?? '').trim())
        .join(' ')
        .trim()
      if (!ownText) continue
      if (el.getClientRects().length === 0) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      if (parseFloat(style.opacity) === 0) continue
      inspected++
      const px = parseFloat(style.fontSize)
      if (!Number.isFinite(px) || px >= floor) continue
      const testid = el.getAttribute('data-testid')
      tooSmall.push({
        text: ownText.slice(0, 40),
        px,
        where: `${el.tagName.toLowerCase()}${testid ? `[${testid}]` : ''}.${String(el.className).slice(0, 60)}`,
      })
    }
    return { tooSmall, inspected }
  }, FLOOR_PX)
}

function describeViolations(result: Sweep): string {
  return result.tooSmall.map((t) => `  ${t.px}px ${t.where} — "${t.text}"`).join('\n')
}

test.describe('font floor', () => {
  let handle: AppHandle
  test.beforeEach(async () => {
    handle = await launchApp()
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  test('no visible app text renders below 11px', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await page.getByTestId('new-document-btn').click()
    await expect(page.locator('.cm-content')).toBeVisible()
    await page.locator('.cm-content').click()
    await page.keyboard.type('hello world')

    // Sweep 1 — the main window: editor chrome, sidebar, status bar.
    const main = await sweepFontSizes(page)
    expect(
      main.tooSmall,
      `text below the ${FLOOR_PX}px floor:\n${describeViolations(main)}`,
    ).toEqual([])
    expect(main.inspected, 'the main-window sweep inspected too few text nodes').toBeGreaterThan(5)

    // Sweep 2 — the command palette: a dense overlay of small labels (command names, shortcut
    // hints). It is the most label-dense surface in the app, so it is the best second sample.
    await page.keyboard.press('Control+k')
    await expect(page.locator('[data-modal-surface]').first()).toBeVisible()
    const palette = await sweepFontSizes(page)
    expect(
      palette.tooSmall,
      `text below the ${FLOOR_PX}px floor in the command palette:\n${describeViolations(palette)}`,
    ).toEqual([])
    expect(palette.inspected, 'the palette sweep inspected too few text nodes').toBeGreaterThan(5)
  })
})
